function parseExcel(pasteText) {
  // simple tsv parsing
  const rows = pasteText.split(/\r?\n/).filter(r => r.trim());
  const grid = rows.map(r => r.split('\t'));
  console.log(grid);
}
parseExcel("Item Name\tQty\tRate\nApple\t10\t5.5\nOrange\t5\t3.0");
