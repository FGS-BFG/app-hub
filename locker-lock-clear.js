export async function verifyLockClear(command, boards) {
  // MCI 304 quiet mode sends no acknowledgement for the global clear.
  await command('LC', null);
  for (const board of boards) {
    const response = new RegExp('<' + board + '>\\s*Lock Word:\\s*([01]{16})[\\r\\n~]', 'i');
    const reply = await command('LRS#' + board, response);
    const word = response.exec(reply)?.[1];
    if (!word) throw new Error('Invalid lock output reply from board ' + board);
    if (word.includes('1')) throw new Error('Board ' + board + ' still reports an active lock output after LC');
  }
}
