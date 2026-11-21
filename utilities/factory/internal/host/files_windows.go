package host

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var reopenFile = windows.NewLazySystemDLL("kernel32.dll").NewProc("ReOpenFile")

// OpenAt открывает файл относительно handle корня и запрещает reparse points.
// Для нового приватного файла DACL передаётся ядру при создании.
func OpenAt(root *os.Root, name string, flags int, mode os.FileMode, options FileOptions) (*os.File, error) {
	if !filepath.IsLocal(name) || filepath.Clean(name) != name || strings.Contains(name, ":") {
		return nil, os.ErrInvalid
	}
	directory, err := root.Open(".")
	if err != nil {
		return nil, err
	}
	defer directory.Close()

	access := uint32(windows.FILE_GENERIC_READ)
	if flags&(os.O_RDWR|os.O_WRONLY) != 0 {
		access |= windows.FILE_GENERIC_WRITE
	}
	if flags&os.O_APPEND != 0 {
		access = access&^windows.FILE_WRITE_DATA | windows.FILE_APPEND_DATA
	}
	if options&ChangeMode != 0 {
		access |= windows.WRITE_DAC
	}
	const share = windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE | windows.FILE_SHARE_DELETE
	if name == "." {
		if options&Directory == 0 {
			return nil, os.ErrInvalid
		}
		raw, _, err := reopenFile.Call(directory.Fd(), uintptr(access), share,
			windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT)
		if windows.Handle(raw) == windows.InvalidHandle {
			return nil, err
		}
		return os.NewFile(raw, root.Name()), nil
	}
	relative, err := windows.NewNTUnicodeString(name)
	if err != nil {
		return nil, err
	}
	attribute := windows.OBJECT_ATTRIBUTES{
		RootDirectory: windows.Handle(directory.Fd()),
		ObjectName:    relative,
		Attributes:    windows.OBJ_DONT_REPARSE | windows.OBJ_CASE_INSENSITIVE,
	}
	attribute.Length = uint32(unsafe.Sizeof(attribute))

	disposition := uint32(windows.FILE_OPEN)
	if flags&os.O_CREATE != 0 {
		disposition = windows.FILE_OPEN_IF
		if flags&os.O_EXCL != 0 {
			disposition = windows.FILE_CREATE
		}
		attribute.SecurityDescriptor, err = privateDescriptor(mode)
		if err != nil {
			return nil, err
		}
	}
	if flags&os.O_TRUNC != 0 {
		return nil, os.ErrInvalid
	}
	nativeOptions := uint32(windows.FILE_SYNCHRONOUS_IO_NONALERT | windows.FILE_NON_DIRECTORY_FILE)
	if options&Directory != 0 {
		nativeOptions = windows.FILE_SYNCHRONOUS_IO_NONALERT | windows.FILE_DIRECTORY_FILE
	}

	var file windows.Handle
	err = windows.NtCreateFile(&file, access, &attribute, &windows.IO_STATUS_BLOCK{},
		nil, 0, share, disposition, nativeOptions, 0, 0)
	if status, ok := err.(windows.NTStatus); ok {
		return nil, status.Errno()
	}
	if err != nil {
		return nil, err
	}

	return os.NewFile(uintptr(file), filepath.Join(root.Name(), name)), nil
}

// OpenPath сохраняет семантику открытия через родителя.
// Сам файл открывается относительно дескриптора физического каталога.
func OpenPath(name string, flags int, mode os.FileMode, options FileOptions) (*os.File, error) {
	root, err := os.OpenRoot(filepath.Dir(name))
	if err != nil {
		return nil, err
	}
	defer root.Close()

	return OpenAt(root, filepath.Base(name), flags, mode, options)
}

func FileOwner(file *os.File, _ os.FileInfo) bool {
	sd, err := windows.GetSecurityInfo(windows.Handle(file.Fd()), windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return false
	}
	owner, _, err := sd.Owner()
	self, tokenErr := windows.GetCurrentProcessToken().GetTokenUser()

	return err == nil && tokenErr == nil && owner != nil && owner.Equals(self.User.Sid)
}

func SingleLink(file *os.File, _ os.FileInfo) bool {
	var info windows.ByHandleFileInformation

	return windows.GetFileInformationByHandle(windows.Handle(file.Fd()), &info) == nil && info.NumberOfLinks == 1
}

// PrivateMode требует ограниченный DACL и нужное право записи у владельца.
// SYSTEM и Administrators получают тот же административный доступ, что root в Unix.
func PrivateMode(file *os.File, info os.FileInfo, mode os.FileMode) bool {
	if !FileOwner(file, info) {
		return false
	}
	sd, err := windows.GetSecurityInfo(windows.Handle(file.Fd()), windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return false
	}
	acl, _, err := sd.DACL()
	self, tokenErr := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil || tokenErr != nil || acl == nil {
		return false
	}
	var ownerMask windows.ACCESS_MASK
	for i := uint16(0); i < acl.AceCount; i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(acl, uint32(i), &ace); err != nil {
			return false
		}
		if ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 {
			continue
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return false
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		switch {
		case sid.Equals(self.User.Sid):
			ownerMask |= ace.Mask
		case sid.IsWellKnown(windows.WinLocalSystemSid), sid.IsWellKnown(windows.WinBuiltinAdministratorsSid):
		default:
			return false
		}
	}

	const read = windows.FILE_READ_DATA | windows.GENERIC_READ | windows.GENERIC_ALL
	const write = windows.FILE_WRITE_DATA | windows.FILE_APPEND_DATA | windows.GENERIC_WRITE | windows.GENERIC_ALL
	return ownerMask&read != 0 && (ownerMask&write != 0) == (mode&0200 != 0)
}

func HasWritablePrivateMode(file *os.File, info os.FileInfo) bool {
	return PrivateMode(file, info, 0600)
}

func SetPrivateMode(file *os.File, mode os.FileMode) error {
	sd, err := privateDescriptor(mode)
	if err != nil {
		return err
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil {
		return errors.New("Windows: не удалось собрать приватный DACL")
	}
	return windows.SetSecurityInfo(windows.Handle(file.Fd()), windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
}

// privateDescriptor закрепляет приватные права независимо от унаследованных ACE.
// У каталога ACE наследуются его файлами и дочерними каталогами.
func privateDescriptor(mode os.FileMode) (*windows.SECURITY_DESCRIPTOR, error) {
	self, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	inherit := ""
	rights := "FR"
	if mode&0100 != 0 {
		inherit = "OICI"
	}
	if mode&0200 != 0 {
		rights = "FA"
	}
	ace := "(A;" + inherit + ";"
	sddl := "D:P" + ace + "FA;;;SY)" + ace + "FA;;;BA)" + ace + rights + ";;;" + self.User.Sid.String() + ")"

	return windows.SecurityDescriptorFromString(sddl)
}

// SyncDirectory оставляет синхронизацию содержимого открытым файловым handle.
// Windows не предоставляет здесь эквивалент Unix fsync для handle каталога.
func SyncDirectory(_ *os.Root, _ string) error {
	return nil
}

func RealFileOwner(file *os.File, info os.FileInfo) bool {
	return FileOwner(file, info)
}

// Linux-транзакция требует nlink из стат-снимка пути.
// На Windows она отключена в движке и не получает допуск при случайном вызове.
func NativeSingleLink(_ os.FileInfo) bool {
	return false
}

func Executable(name string, info os.FileInfo) bool {
	return info.Mode().IsRegular() && strings.EqualFold(filepath.Ext(name), ".exe")
}
