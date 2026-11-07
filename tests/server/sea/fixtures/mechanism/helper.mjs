// Вспомогательный процесс механизма: печатает argv, версию Node и ABI.
const payload = {
  argv: process.argv.slice(2),
  self: process.argv[1],
  node: process.version,
  abi: process.versions.modules,
  execPath: process.execPath,
};

process.stdout.write(JSON.stringify(payload));
