import React, { useState, useEffect } from 'react';
import {
  RotateCcw,
  Plus,
  Search,
  Printer,
  Eye,
  Trash2,
  Calendar,
  DollarSign,
  AlertCircle,
  X,
  FileText,
  User,
  Package,
  CreditCard
} from 'lucide-react';
import { StorageService } from '../lib/storage';
import { SaleReturn, SaleReturnItem, Customer, Product, SaleInvoice } from '../types';

interface SalesReturnProps {
  currentCompanyId: string;
}

export const SalesReturnManagement: React.FC<SalesReturnProps> = ({ currentCompanyId }) => {
  const [returns, setReturns] = useState<SaleReturn[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [invoices, setInvoices] = useState<SaleInvoice[]>([]);
  
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [viewingReturn, setViewingReturn] = useState<SaleReturn | null>(null);
  
  // Form State
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [selectedInvoiceId, setSelectedInvoiceId] = useState('');
  const [returnType, setReturnType] = useState<'CREDIT' | 'CASH'>('CREDIT');
  const [returnDate, setReturnDate] = useState(new Date().toISOString().split('T')[0]);
  const [reason, setReason] = useState('Defective / Returned Item');
  const [notes, setNotes] = useState('');
  const [discountAmount, setDiscountAmount] = useState<number>(0);

  const [items, setItems] = useState<Array<{
    productId: string;
    productCode: string;
    productName: string;
    unit: string;
    quantity: number;
    unitPrice: number;
    total: number;
  }>>([]);

  const [isSaving, setIsSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    loadData();
  }, [currentCompanyId]);

  const loadData = () => {
    setReturns(StorageService.getSaleReturns(currentCompanyId));
    setCustomers(StorageService.getCustomers(currentCompanyId));
    setProducts(StorageService.getProducts(currentCompanyId));
    setInvoices(StorageService.getSales(currentCompanyId));
  };

  const handleInvoiceSelect = (invId: string) => {
    setSelectedInvoiceId(invId);
    if (!invId) return;
    const inv = invoices.find((i) => i.id === invId);
    if (inv) {
      if (inv.customerId) setSelectedCustomerId(inv.customerId);
      const mappedItems = (inv.items || []).map((item) => ({
        productId: item.productId,
        productCode: item.productCode || '',
        productName: item.productName || 'Item',
        unit: item.unit || 'Pcs',
        quantity: item.quantity || 1,
        unitPrice: item.unitPrice || 0,
        total: item.total || 0
      }));
      setItems(mappedItems);
    }
  };

  const handleAddItemRow = () => {
    if (products.length === 0) return;
    const firstP = products[0];
    setItems((prev) => [
      ...prev,
      {
        productId: firstP.id,
        productCode: firstP.code || '',
        productName: firstP.name,
        unit: firstP.unit || 'Pcs',
        quantity: 1,
        unitPrice: firstP.sellingPrice || 0,
        total: firstP.sellingPrice || 0
      }
    ]);
  };

  const handleItemChange = (index: number, field: string, value: any) => {
    setItems((prev) => {
      const updated = [...prev];
      const item = { ...updated[index] };
      if (field === 'productId') {
        const p = products.find((prod) => prod.id === value);
        if (p) {
          item.productId = p.id;
          item.productCode = p.code || '';
          item.productName = p.name;
          item.unit = p.unit || 'Pcs';
          item.unitPrice = p.sellingPrice || 0;
        }
      } else if (field === 'quantity') {
        item.quantity = Math.max(1, Number(value) || 0);
      } else if (field === 'unitPrice') {
        item.unitPrice = Math.max(0, Number(value) || 0);
      }
      item.total = Number((item.quantity * item.unitPrice).toFixed(2));
      updated[index] = item;
      return updated;
    });
  };

  const handleRemoveItemRow = (index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  const calculateSubtotal = () => items.reduce((sum, i) => sum + i.total, 0);
  const calculateGrandTotal = () => Math.max(0, calculateSubtotal() - discountAmount);

  const resetForm = () => {
    setSelectedCustomerId('');
    setSelectedInvoiceId('');
    setReturnType('CREDIT');
    setReturnDate(new Date().toISOString().split('T')[0]);
    setReason('Defective / Returned Item');
    setNotes('');
    setDiscountAmount(0);
    setItems([]);
    setFeedback(null);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCustomerId) {
      setFeedback({ type: 'error', message: 'Please select a customer.' });
      return;
    }
    if (items.length === 0) {
      setFeedback({ type: 'error', message: 'Please add at least one item to return.' });
      return;
    }

    setIsSaving(true);
    setFeedback(null);

    const cust = customers.find((c) => c.id === selectedCustomerId);
    const inv = invoices.find((i) => i.id === selectedInvoiceId);

    const subtotal = calculateSubtotal();
    const grandTotal = calculateGrandTotal();

    const result = await StorageService.createSaleReturnAsync(
      {
        companyId: currentCompanyId,
        date: returnDate,
        customerId: selectedCustomerId,
        customerName: cust ? cust.name : 'Unknown Customer',
        invoiceId: selectedInvoiceId || undefined,
        invoiceNumber: inv ? inv.invoiceNumber : undefined,
        reason,
        type: returnType,
        items,
        subtotal,
        discount: discountAmount,
        discountAmount,
        taxAmount: 0,
        grandTotal,
        notes,
        status: 'COMPLETED'
      },
      currentCompanyId
    );

    setIsSaving(false);
    if (result.success) {
      loadData();
      setIsModalOpen(false);
      resetForm();
    } else {
      setFeedback({ type: 'error', message: result.error || 'Failed to record sales return.' });
    }
  };

  const handleDelete = async (id: string, returnNo: string) => {
    if (window.confirm(`Are you sure you want to void Sales Return ${returnNo}? Stock will be reversed.`)) {
      await StorageService.deleteSaleReturnAsync(id);
      loadData();
    }
  };

  const filteredReturns = returns.filter(
    (r) =>
      r.returnNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      r.customerName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (r.invoiceNumber && r.invoiceNumber.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-2 bg-rose-50 rounded-lg text-rose-600">
              <RotateCcw className="w-5 h-5" />
            </div>
            <h1 className="text-xl font-bold text-slate-800">Sales Return (Credit Note)</h1>
          </div>
          <p className="text-sm text-slate-5-0 mt-1 pl-9">
            Process customer item returns, update stock counts (Stock IN), and adjust customer credit balance.
          </p>
        </div>
        <button
          onClick={() => {
            resetForm();
            setIsModalOpen(true);
          }}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-rose-600 text-white font-medium text-sm rounded-lg hover:bg-rose-700 transition-colors shadow-sm"
        >
          <Plus className="w-4 h-4" />
          Create Sales Return
        </button>
      </div>

      {/* Search & Filter */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search return #, customer name, or invoice #..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500"
          />
        </div>
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
          Total Returns: {returns.length}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                <th className="px-5 py-3.5">Return No</th>
                <th className="px-5 py-3.5">Date</th>
                <th className="px-5 py-3.5">Customer</th>
                <th className="px-5 py-3.5">Ref Invoice</th>
                <th className="px-5 py-3.5">Type</th>
                <th className="px-5 py-3.5 text-right">Items</th>
                <th className="px-5 py-3.5 text-right">Grand Total</th>
                <th className="px-5 py-3.5 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {filteredReturns.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center text-slate-400">
                    <RotateCcw className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                    No sales returns recorded yet.
                  </td>
                </tr>
              ) : (
                filteredReturns.map((ret) => (
                  <tr key={ret.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="px-5 py-3.5 font-semibold text-rose-700">{ret.returnNumber}</td>
                    <td className="px-5 py-3.5 text-slate-600">{ret.date}</td>
                    <td className="px-5 py-3.5 font-medium text-slate-800">{ret.customerName}</td>
                    <td className="px-5 py-3.5 text-slate-500">{ret.invoiceNumber || '—'}</td>
                    <td className="px-5 py-3.5">
                      <span
                        className={`inline-flex px-2 py-0.5 text-xs font-semibold rounded-full ${
                          ret.type === 'CREDIT'
                            ? 'bg-purple-50 text-purple-700 border border-purple-200'
                            : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        }`}
                      >
                        {ret.type === 'CREDIT' ? 'Credit Note' : 'Cash Refund'}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-right text-slate-600 font-mono">
                      {(ret.items || []).reduce((acc, i) => acc + i.quantity, 0)} Pcs
                    </td>
                    <td className="px-5 py-3.5 text-right font-bold text-slate-900 font-mono">
                      Rs. {ret.grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center justify-center gap-2">
                        <button
                          onClick={() => setViewingReturn(ret)}
                          title="View Return Voucher"
                          className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md transition-colors"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(ret.id, ret.returnNumber)}
                          title="Void Sales Return"
                          className="p-1.5 text-rose-500 hover:text-rose-700 hover:bg-rose-50 rounded-md transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* CREATE SALES RETURN MODAL */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col my-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50 rounded-t-xl">
              <div className="flex items-center gap-2">
                <RotateCcw className="w-5 h-5 text-rose-600" />
                <h2 className="text-lg font-bold text-slate-800">New Sales Return (Stock IN)</h2>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-200/60"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="flex-1 overflow-y-auto p-6 space-y-6">
              {feedback && (
                <div
                  className={`p-3.5 rounded-lg text-sm flex items-center gap-2 ${
                    feedback.type === 'error'
                      ? 'bg-rose-50 border border-rose-200 text-rose-700'
                      : 'bg-emerald-50 border border-emerald-200 text-emerald-700'
                  }`}
                >
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {feedback.message}
                </div>
              )}

              {/* Top Row fields */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Customer *</label>
                  <select
                    value={selectedCustomerId}
                    onChange={(e) => setSelectedCustomerId(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500"
                    required
                  >
                    <option value="">Select Customer...</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} (Bal: Rs. {c.outstandingBalance})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Original Invoice (Optional)</label>
                  <select
                    value={selectedInvoiceId}
                    onChange={(e) => handleInvoiceSelect(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500"
                  >
                    <option value="">Manual / No Invoice link</option>
                    {invoices.map((inv) => (
                      <option key={inv.id} value={inv.id}>
                        {inv.invoiceNumber} - {inv.customerName} (Rs. {inv.grandTotal})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Return Date</label>
                  <input
                    type="date"
                    value={returnDate}
                    onChange={(e) => setReturnDate(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Return Type</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setReturnType('CREDIT')}
                      className={`px-3 py-2 rounded-lg text-xs font-semibold border text-center transition-colors ${
                        returnType === 'CREDIT'
                          ? 'bg-rose-50 border-rose-500 text-rose-700'
                          : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      Credit Note (Reduce Debt)
                    </button>
                    <button
                      type="button"
                      onClick={() => setReturnType('CASH')}
                      className={`px-3 py-2 rounded-lg text-xs font-semibold border text-center transition-colors ${
                        returnType === 'CASH'
                          ? 'bg-rose-50 border-rose-500 text-rose-700'
                          : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      Cash Refund
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Reason for Return</label>
                  <input
                    type="text"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. Faulty goods, wrong size, customer cancellation"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500"
                  />
                </div>
              </div>

              {/* Items Section */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-bold text-slate-800">Return Line Items (Stock Increase)</h3>
                  <button
                    type="button"
                    onClick={handleAddItemRow}
                    className="text-xs font-semibold text-rose-600 hover:text-rose-700 inline-flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Item Row
                  </button>
                </div>

                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-100 border-b border-slate-200 text-slate-600 font-semibold">
                      <tr>
                        <th className="px-3 py-2">Product</th>
                        <th className="px-3 py-2 w-24">Unit</th>
                        <th className="px-3 py-2 w-24 text-right">Qty</th>
                        <th className="px-3 py-2 w-32 text-right">Unit Price</th>
                        <th className="px-3 py-2 w-32 text-right">Total</th>
                        <th className="px-2 py-2 w-10 text-center"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {items.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-3 py-6 text-center text-slate-400">
                            No items added. Click "Add Item Row" or select an invoice above.
                          </td>
                        </tr>
                      ) : (
                        items.map((item, idx) => (
                          <tr key={idx} className="bg-white">
                            <td className="px-3 py-2">
                              <select
                                value={item.productId}
                                onChange={(e) => handleItemChange(idx, 'productId', e.target.value)}
                                className="w-full px-2 py-1 border border-slate-300 rounded text-xs focus:outline-none focus:border-rose-500"
                              >
                                {products.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name} ({p.code})
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="px-3 py-2 text-slate-500">{item.unit}</td>
                            <td className="px-3 py-2">
                              <input
                                type="number"
                                min="1"
                                value={item.quantity}
                                onChange={(e) => handleItemChange(idx, 'quantity', e.target.value)}
                                className="w-full px-2 py-1 border border-slate-300 rounded text-xs text-right focus:outline-none focus:border-rose-500"
                              />
                            </td>
                            <td className="px-3 py-2">
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={item.unitPrice}
                                onChange={(e) => handleItemChange(idx, 'unitPrice', e.target.value)}
                                className="w-full px-2 py-1 border border-slate-300 rounded text-xs text-right focus:outline-none focus:border-rose-500"
                              />
                            </td>
                            <td className="px-3 py-2 text-right font-mono font-semibold text-slate-800">
                              Rs. {item.total.toFixed(2)}
                            </td>
                            <td className="px-2 py-2 text-center">
                              <button
                                type="button"
                                onClick={() => handleRemoveItemRow(idx)}
                                className="text-slate-400 hover:text-rose-600 p-1"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Summary */}
              <div className="flex justify-end pt-2 border-t border-slate-200">
                <div className="w-64 space-y-2 text-xs">
                  <div className="flex justify-between text-slate-600">
                    <span>Subtotal:</span>
                    <span className="font-mono font-semibold">Rs. {calculateSubtotal().toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between items-center text-slate-600">
                    <span>Discount / Adjustment:</span>
                    <input
                      type="number"
                      min="0"
                      value={discountAmount}
                      onChange={(e) => setDiscountAmount(Number(e.target.value) || 0)}
                      className="w-24 px-2 py-1 border border-slate-300 rounded text-xs text-right"
                    />
                  </div>
                  <div className="flex justify-between text-sm font-bold text-slate-900 pt-2 border-t border-slate-200">
                    <span>Grand Total:</span>
                    <span className="font-mono text-rose-700">Rs. {calculateGrandTotal().toFixed(2)}</span>
                  </div>
                </div>
              </div>

              {/* Notes */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Notes / Internal Remarks</label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Additional remarks..."
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500"
                />
              </div>

              {/* Action Buttons */}
              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 border border-slate-300 text-slate-700 font-medium text-xs rounded-lg hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="px-5 py-2 bg-rose-600 text-white font-medium text-xs rounded-lg hover:bg-rose-700 disabled:opacity-50"
                >
                  {isSaving ? 'Processing Return...' : 'Save Sales Return'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* VIEW RETURN VOUCHER MODAL */}
      {viewingReturn && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-xl border border-slate-200 shadow-xl max-w-2xl w-full p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-slate-200 pb-4">
              <div>
                <span className="text-xs font-semibold text-rose-600 uppercase tracking-wider">Credit Note Voucher</span>
                <h2 className="text-xl font-bold text-slate-900">{viewingReturn.returnNumber}</h2>
              </div>
              <button
                onClick={() => setViewingReturn(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <span className="text-slate-500 block">Customer</span>
                <span className="font-bold text-slate-800 text-sm">{viewingReturn.customerName}</span>
              </div>
              <div>
                <span className="text-slate-500 block">Return Date</span>
                <span className="font-semibold text-slate-800">{viewingReturn.date}</span>
              </div>
              <div>
                <span className="text-slate-500 block">Original Invoice</span>
                <span className="font-semibold text-slate-800">{viewingReturn.invoiceNumber || 'Manual Return'}</span>
              </div>
              <div>
                <span className="text-slate-500 block">Return Mode</span>
                <span className="font-semibold text-rose-700">{viewingReturn.type}</span>
              </div>
            </div>

            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
                  <tr>
                    <th className="px-3 py-2">Item</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {(viewingReturn.items || []).map((item, idx) => (
                    <tr key={idx}>
                      <td className="px-3 py-2 font-medium text-slate-800">{item.productName} ({item.productCode})</td>
                      <td className="px-3 py-2 text-right font-mono">{item.quantity} {item.unit}</td>
                      <td className="px-3 py-2 text-right font-mono">Rs. {item.unitPrice.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-mono font-bold">Rs. {item.total.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-between items-center pt-2 text-xs">
              <span className="text-slate-500">Reason: {viewingReturn.reason || 'None'}</span>
              <div className="text-right">
                <span className="text-slate-500 block">Grand Total</span>
                <span className="text-lg font-bold text-rose-700 font-mono">
                  Rs. {viewingReturn.grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </span>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-4 border-t border-slate-200">
              <button
                onClick={() => window.print()}
                className="px-4 py-2 bg-slate-800 text-white rounded-lg text-xs font-medium inline-flex items-center gap-1.5 hover:bg-slate-900"
              >
                <Printer className="w-4 h-4" />
                Print Voucher
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
