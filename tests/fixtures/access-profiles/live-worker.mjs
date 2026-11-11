process.send({
  type: 'ready',
  env: {
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    CODEX_HOME: process.env.CODEX_HOME,
  },
});

process.on('message', (message) => {
  if (message.type === 'send') {
    process.send({ type: 'result', reply: 'Ответ живого процесса' });
  }
});
