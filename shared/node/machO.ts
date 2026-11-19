/**
 * Узнаёт thin Mach-O executable Apple Silicon по фиксированному заголовку.
 * Fat binaries, arm64 библиотеки и файлы с неполным заголовком не допускаются.
 */
export function isArm64MachOExecutable(bytes: Buffer): boolean {
  return bytes.length >= 32
    && bytes.readUInt32LE(0) === 0xfeedfacf
    && bytes.readUInt32LE(4) === 0x0100000c
    && bytes.readUInt32LE(12) === 2;
}
