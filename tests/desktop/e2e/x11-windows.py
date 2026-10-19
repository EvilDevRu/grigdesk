# Читает только окна одноразового Xvfb; доступа к чужому рабочему столу нет.
import ctypes as c
import ctypes.util
import json

x = c.CDLL(ctypes.util.find_library('X11'))
x.XOpenDisplay.restype = c.c_void_p
x.XOpenDisplay.argtypes = [c.c_char_p]
x.XDefaultRootWindow.argtypes = [c.c_void_p]
x.XDefaultRootWindow.restype = c.c_ulong
x.XQueryTree.argtypes = [c.c_void_p, c.c_ulong, c.POINTER(c.c_ulong), c.POINTER(c.c_ulong),
                        c.POINTER(c.POINTER(c.c_ulong)), c.POINTER(c.c_uint)]
x.XFetchName.argtypes = [c.c_void_p, c.c_ulong, c.POINTER(c.c_void_p)]
x.XInternAtom.argtypes = [c.c_void_p, c.c_char_p, c.c_int]
x.XInternAtom.restype = c.c_ulong
x.XGetWindowProperty.argtypes = [c.c_void_p, c.c_ulong, c.c_ulong, c.c_long, c.c_long,
                                c.c_int, c.c_ulong, c.POINTER(c.c_ulong), c.POINTER(c.c_int),
                                c.POINTER(c.c_ulong), c.POINTER(c.c_ulong), c.POINTER(c.c_void_p)]
x.XFree.argtypes = [c.c_void_p]
x.XCloseDisplay.argtypes = [c.c_void_p]

class Attr(c.Structure):
    _fields_ = [('x', c.c_int), ('y', c.c_int), ('width', c.c_int), ('height', c.c_int),
                ('border', c.c_int), ('depth', c.c_int), ('visual', c.c_void_p), ('root', c.c_ulong),
                ('class_', c.c_int), ('bit_gravity', c.c_int), ('win_gravity', c.c_int),
                ('backing_store', c.c_int), ('backing_planes', c.c_ulong), ('backing_pixel', c.c_ulong),
                ('save_under', c.c_int), ('colormap', c.c_ulong), ('map_installed', c.c_int),
                ('map_state', c.c_int), ('all_event_masks', c.c_long), ('your_event_mask', c.c_long),
                ('do_not_propagate_mask', c.c_long), ('override_redirect', c.c_int), ('screen', c.c_void_p)]

x.XGetWindowAttributes.argtypes = [c.c_void_p, c.c_ulong, c.POINTER(Attr)]
display = x.XOpenDisplay(None)
if not display:
    raise RuntimeError('Xvfb недоступен')
root = x.XDefaultRootWindow(display)
root_attr = Attr()
x.XGetWindowAttributes(display, root, c.byref(root_attr))
parent = c.c_ulong()
root_return = c.c_ulong()
children = c.POINTER(c.c_ulong)()
count = c.c_uint()
x.XQueryTree(display, root, c.byref(root_return), c.byref(parent), c.byref(children), c.byref(count))
windows = []
for index in range(count.value):
    window = children[index]
    name = c.c_void_p()
    attr = Attr()
    x.XGetWindowAttributes(display, window, c.byref(attr))
    x.XFetchName(display, window, c.byref(name))
    text = c.string_at(name.value).decode('utf-8', errors='replace') if name.value else ''
    if name.value:
        x.XFree(name)
    if not text:
        actual_type, actual_format = c.c_ulong(), c.c_int()
        items, after, prop = c.c_ulong(), c.c_ulong(), c.c_void_p()
        atom = x.XInternAtom(display, b'_NET_WM_NAME', 0)
        x.XGetWindowProperty(display, window, atom, 0, 4096, 0, 0, c.byref(actual_type),
                             c.byref(actual_format), c.byref(items), c.byref(after), c.byref(prop))
        if prop.value:
            text = c.string_at(prop.value, items.value).decode('utf-8', errors='replace')
            x.XFree(prop)
    windows.append({'title': text, 'width': attr.width, 'height': attr.height, 'visible': attr.map_state == 2})
x.XFree(children)
x.XCloseDisplay(display)
print(json.dumps({'width': root_attr.width, 'height': root_attr.height, 'windows': windows}))
