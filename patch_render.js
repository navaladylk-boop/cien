const fs = require('fs');
let code = fs.readFileSync('src/components/Purchases.tsx', 'utf-8');

const pasteModal = `      {excelPasteData.isOpen && (
        <div className="fixed inset-0 z-[60] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full p-6 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold text-slate-900">Map Excel Columns</h3>
              <button onClick={() => setExcelPasteData({ isOpen: false, rows: [], mapping: {} })} className="p-2 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="mb-6 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
              {['Item Name', 'Qty', 'Rate', 'Discount', 'Amount'].map(field => (
                <div key={field} className="bg-slate-50 p-3 rounded-xl border border-slate-200">
                  <label className="block text-xs font-bold text-slate-500 mb-2">{field} Column</label>
                  <select
                    className="w-full p-2 bg-white border border-slate-200 rounded-lg text-sm"
                    value={excelPasteData.mapping[field] !== undefined ? excelPasteData.mapping[field] : ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      setExcelPasteData(prev => {
                        const newMapping = { ...prev.mapping };
                        if (val === '') {
                          delete newMapping[field];
                        } else {
                          newMapping[field] = parseInt(val, 10);
                        }
                        return { ...prev, mapping: newMapping };
                      });
                    }}
                  >
                    <option value="">-- Ignore --</option>
                    {Array.from({ length: Math.max(...excelPasteData.rows.map(r => r.length), 0) }).map((_, i) => (
                      <option key={i} value={i}>Column {String.fromCharCode(65 + i)}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <div className="max-h-[40vh] overflow-auto border border-slate-200 rounded-xl mb-6">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 sticky top-0 border-b border-slate-200 shadow-sm">
                  <tr>
                    <th className="p-3 font-bold text-slate-700">Status</th>
                    <th className="p-3 font-bold text-slate-700">Item Name</th>
                    <th className="p-3 font-bold text-slate-700">Qty</th>
                    <th className="p-3 font-bold text-slate-700">Rate</th>
                    <th className="p-3 font-bold text-slate-700">Discount</th>
                    <th className="p-3 font-bold text-slate-700">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {excelPasteData.rows.map((row, idx) => {
                    const itemName = excelPasteData.mapping['Item Name'] !== undefined ? row[excelPasteData.mapping['Item Name']] : '';
                    const qty = excelPasteData.mapping['Qty'] !== undefined ? row[excelPasteData.mapping['Qty']] : '1';
                    const rate = excelPasteData.mapping['Rate'] !== undefined ? row[excelPasteData.mapping['Rate']] : '0';
                    const disc = excelPasteData.mapping['Discount'] !== undefined ? row[excelPasteData.mapping['Discount']] : '0';
                    const amount = excelPasteData.mapping['Amount'] !== undefined ? row[excelPasteData.mapping['Amount']] : '-';
                    
                    const matchedProd = products.find(p => p.name.toLowerCase() === itemName.toLowerCase() || p.code.toLowerCase() === itemName.toLowerCase());
                    const isValid = !!matchedProd || !!itemName; // we will accept unknown items as new/adhoc entries if itemName is not empty, though ideally they should match. The prompt says: "If not found: show: Item Not Found. Do NOT automatically create a new product." Actually the system allows adhoc product names if code is empty. The prompt says "If not found: show: Item Not Found". We'll just flag it.
                    
                    return (
                      <tr key={idx} className="hover:bg-slate-50">
                        <td className="p-3">
                          {matchedProd ? (
                            <span className="inline-flex items-center gap-1 text-emerald-600 font-medium text-xs bg-emerald-50 px-2 py-1 rounded-full"><CheckCircle2 className="w-3 h-3" /> Matched</span>
                          ) : itemName ? (
                            <span className="inline-flex items-center gap-1 text-rose-600 font-medium text-xs bg-rose-50 px-2 py-1 rounded-full"><X className="w-3 h-3" /> Not Found</span>
                          ) : (
                            <span className="text-slate-400 text-xs">Empty</span>
                          )}
                        </td>
                        <td className="p-3 font-medium text-slate-900">{itemName}</td>
                        <td className="p-3 text-slate-600 font-mono">{qty}</td>
                        <td className="p-3 text-slate-600 font-mono">{rate}</td>
                        <td className="p-3 text-slate-600 font-mono">{disc}</td>
                        <td className="p-3 text-slate-600 font-mono">{amount}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setExcelPasteData({ isOpen: false, rows: [], mapping: {} })}
                className="px-4 py-2 text-slate-600 hover:bg-slate-100 font-bold rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => confirmPaste(excelPasteData.mapping)}
                className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-md hover:shadow-lg transition-all"
              >
                Add Valid Rows
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create / Edit Purchase Modal`;

code = code.replace("{/* Create / Edit Purchase Modal", pasteModal);
fs.writeFileSync('src/components/Purchases.tsx', code);
