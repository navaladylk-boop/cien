const text = `Item Name\tQty\tRate\tDiscount\tAmount\nApple\t10\t5\t0\t50\nBanana\t20\t2\t0\t40`;

const rows = text.split(/\r?\n/).filter(line => line.trim()).map(line => line.split('\t').map(c => c.trim()));

const firstRow = rows[0].map(c => c.toLowerCase());
const mapping = {};
let hasHeaders = false;
firstRow.forEach((col, idx) => {
  if (col.includes('item') || col.includes('product') || col.includes('name')) { mapping['Item Name'] = idx; hasHeaders = true; }
  else if (col.includes('qty') || col.includes('quantity')) { mapping['Qty'] = idx; hasHeaders = true; }
  else if (col.includes('rate') || col.includes('price') || col.includes('cost')) { mapping['Rate'] = idx; hasHeaders = true; }
  else if (col.includes('discount') || col.includes('disc')) { mapping['Discount'] = idx; hasHeaders = true; }
  else if (col.includes('amount') || col.includes('total')) { mapping['Amount'] = idx; hasHeaders = true; }
});
console.log(mapping);
