import fs from 'node:fs/promises';
import { crc32 } from 'node:zlib';

/**
 * Крошечный ZIP без compression и descriptor. Заголовки используют ровно
 * те типы Unix, которые затем читает реальный preflight.
 */
export async function writeStoredMacZip(archive, entries) {
  const parts = [];
  const directory = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const bytes = Buffer.from(entry.bytes ?? '');
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    const central = Buffer.alloc(46);

    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);

    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(entry.mode, 40);
    central.writeUInt32LE(offset, 42);

    parts.push(local, name, bytes);
    directory.push(central, name);
    offset += local.length + name.length + bytes.length;
  }

  const end = Buffer.alloc(22);

  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.reduce((sum, part) => sum + part.length, 0), 12);
  end.writeUInt32LE(offset, 16);
  await fs.writeFile(archive, Buffer.concat([...parts, ...directory, end]), { mode: 0o444 });
}
