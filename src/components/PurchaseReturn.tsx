import React, { useState, useEffect } from 'react';
import {
  RotateCcw,
  Plus,
  Search,
  Printer,
  Eye,
  Trash2,
  Calendar,
  AlertCircle,
  X,
  Building2,
  Package,
  Edit2
} from 'lucide-react';
import { StorageService } from '../lib/storage';
import { PurchaseReturn, PurchaseReturnItem, Supplier, Product, PurchaseInvoice } from '../types';
import { SearchableSupplierSelect, SearchableProductSelect } from './SearchableSelect';
import { handleEnterKeyNavigation } from '../lib/keyboardNav';

interface PurchaseReturnProps {
  currentCompanyId: string;
}

export const PurchaseReturnManagement: React.FC<PurchaseReturnProps> = ({ currentCompanyId }) => {
  const [returns, setReturns] = useState<PurchaseReturn[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [purchases, setPurchases] = useState<PurchaseInvoice[]>([]);

  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingReturn, setEditingReturn] = useState<PurchaseReturn | null>(null);
  const [viewingReturn, setViewingReturn] = useState<PurchaseReturn | null>(null);

  // Form State
  const [selectedSupplierId, setSelectedSupplierId] = useState('');
  const [selectedPurchaseId, setSelectedPurchaseId] = useState('');
  const [returnType, setReturnType] = useState<'CREDIT' | 'CASH'>('CASH');
  const [returnDate, setReturnDate] = useState(new Date().toISOString().split('T')[0]);
  const [reason, setReason] = useState('Damaged / Defective Stock Returned to Supplier');
  const [notes, setNotes] = useState('');
  const [discountAmount, setDiscountAmount] = useState<number>(0);

  const createEmptyItem = () => ({
    productId: '',
    productCode: '',
    productName: '',
    unit: 'Pcs',
    quantity: 1,
    unitCost: 0,
    total: 0
  });

  const [items, setItems] = useState<Array<{
    productId: string;
    productCode: string;
    productName: string;
    unit: string;
    quantity: number;
    unitCost: number;
    total: number;
  }>>([createEmptyItem()]);

  const [isSaving, setIsSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const settings = StorageService.getSettings();
  const currencySymbol = settings?.currencySymbol || 'Rs.';

  useEffect(() => {
    loadData();
  }, [currentCompanyId]);

  const loadData = () => {
    setReturns(StorageService.getPurchaseReturns(currentCompanyId));
    setSuppliers(StorageService.getSuppliers(currentCompanyId));
    setProducts(StorageService.getProducts(currentCompanyId));
    setPurchases(StorageService.getPurchases(currentCompanyId));
  };

  const handleSupplierSelect = (supplierId: string, _name?: string) => {
    setSelectedSupplierId(supplierId);
    setTimeout(() => {
      const firstProductInput = document.getElementById('purchase-return-product-search-0') as HTMLInputElement | null;
      if (firstProductInput) {
        firstProductInput.focus();
      }
    }, 60);
  };

  const handlePurchaseSelect = (purId: string) => {
    setSelectedPurchaseId(purId);
    if (!purId) return;
    const pur = purchases.find((p) => p.id === purId);
    if (pur) {
      if (pur.supplierId) setSelectedSupplierId(pur.supplierId);
      const mappedItems = (pur.items || []).map((item) => ({
        productId: item.productId,
        productCode: item.productCode || '',
        productName: item.productName || 'Item',
        unit: item.unit || 'Pcs',
        quantity: item.quantity || 1,
        unitCost: item.unitCost || 0,
        total: item.total || 0
      }));
      setItems(mappedItems.length > 0 ? mappedItems : [createEmptyItem()]);
    }
  };

  const handleAddItemRow = () => {
    setItems((prev) => [...prev, createEmptyItem()]);
    const newIdx = items.length;
    setTimeout(() => {
      const prodInput = document.getElementById(`purchase-return-product-search-${newIdx}`) as HTMLInputElement | null;
      if (prodInput) {
        prodInput.focus();
      }
    }, 60);
  };

  const handleProductSelect = (index: number, productId: string) => {
    const prod = products.find((p) => p.id === productId);
    setItems((prev) => {
      const updated = [...prev];
      if (prod) {
        const qty = updated[index]?.quantity || 1;
        const cost = prod.costPrice || 0;
        updated[index] = {
          productId: prod.id,
          productCode: prod.code || '',
          productName: prod.name,
          unit: prod.unit || 'Pcs',
          quantity: qty,
          unitCost: cost,
          total: Number((qty * cost).toFixed(2))
        };
      } else {
        updated[index] = createEmptyItem();
      }
      return updated;
    });

    if (prod) {
      setTimeout(() => {
        const qtyInput = document.getElementById(`purchase-return-qty-input-${index}`) as HTMLInputElement | null;
        if (qtyInput) {
          qtyInput.focus();
          qtyInput.select();
        }
      }, 60);
    }
  };

  const handleItemChange = (index: number, field: 'quantity' | 'unitCost', value: number) => {
    setItems((prev) => {
      const updated = [...prev];
      const item = { ...updated[index] };
      if (field === 'quantity') {
        item.quantity = Math.max(1, value);
      } else if (field === 'unitCost') {
        item.unitCost = Math.max(0, value);
      }
      item.total = Number((item.quantity * item.unitCost).toFixed(2));
      updated[index] = item;
      return updated;
    });
  };

  const handleRemoveItemRow = (index: number) => {
    setItems((prev) => {
      const filtered = prev.filter((_, i) => i !== index);
      return filtered.length > 0 ? filtered : [createEmptyItem()];
    });
  };

  const calculateSubtotal = () => items.reduce((sum, i) => sum + i.total, 0);
  const calculateGrandTotal = () => Math.max(0, calculateSubtotal() - discountAmount);

  const resetForm = () => {
    setEditingReturn(null);
    setSelectedSupplierId('');
    setSelectedPurchaseId('');
    setReturnType('CASH');
    setReturnDate(new Date().toISOString().split('T')[0]);
    setReason('Damaged / Defective Stock Returned to Supplier');
    setNotes('');
    setDiscountAmount(0);
    setItems([createEmptyItem()]);
    setFeedback(null);
  };

  const handleOpenEditModal = (ret: PurchaseReturn) => {
    setEditingReturn(ret);
    setSelectedSupplierId(ret.supplierId || '');
    setSelectedPurchaseId(ret.purchaseId || '');
    setReturnType(ret.type || 'CASH');
    setReturnDate(ret.date || new Date().toISOString().split('T')[0]);
    setReason(ret.reason || 'Damaged / Defective Stock Returned to Supplier');
    setNotes(ret.notes || '');
    setDiscountAmount(ret.discount || ret.discountAmount || 0);

    const mappedItems = (ret.items || []).map((i) => ({
      productId: i.productId,
      productCode: i.productCode || '',
      productName: i.productName || 'Item',
      unit: i.unit || 'Pcs',
      quantity: i.quantity || 1,
      unitCost: i.unitCost || (i as any).unitPrice || 0,
      total: i.total || 0
    }));

    setItems(mappedItems.length > 0 ? mappedItems : [createEmptyItem()]);
    setFeedback(null);
    setIsModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSupplierId) {
      setFeedback({ type: 'error', message: 'Please select a supplier.' });
      return;
    }

    const validItems = items.filter((i) => i.productId && i.quantity > 0);
    if (validItems.length === 0) {
      setFeedback({ type: 'error', message: 'Please select at least one valid product item to return.' });
      return;
    }

    setIsSaving(true);
    setFeedback(null);

    const supp = suppliers.find((s) => s.id === selectedSupplierId);
    const pur = purchases.find((p) => p.id === selectedPurchaseId);

    const subtotal = validItems.reduce((sum, i) => sum + i.total, 0);
    const grandTotal = Math.max(0, subtotal - discountAmount);

    let result;
    if (editingReturn) {
      result = await StorageService.updatePurchaseReturnAsync(
        editingReturn.id,
        {
          companyId: currentCompanyId,
          date: returnDate,
          supplierId: selectedSupplierId,
          supplierName: supp ? supp.name : 'Unknown Supplier',
          purchaseId: selectedPurchaseId || undefined,
          purchaseNumber: pur ? pur.purchaseNumber : undefined,
          reason,
          type: returnType,
          items: validItems,
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
    } else {
      result = await StorageService.createPurchaseReturnAsync(
        {
          companyId: currentCompanyId,
          date: returnDate,
          supplierId: selectedSupplierId,
          supplierName: supp ? supp.name : 'Unknown Supplier',
          purchaseId: selectedPurchaseId || undefined,
          purchaseNumber: pur ? pur.purchaseNumber : undefined,
          reason,
          type: returnType,
          items: validItems,
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
    }

    setIsSaving(false);
    if (result.success) {
      loadData();
      setIsModalOpen(false);
      resetForm();
    } else {
      setFeedback({ type: 'error', message: result.error || 'Failed to record purchase return.' });
    }
  };

  const handleDelete = async (id: string, returnNo: string) => {
    if (window.confirm(`Are you sure you want to void Purchase Return ${returnNo}? Stock will be reversed.`)) {
      const res = await StorageService.deletePurchaseReturnAsync(id, currentCompanyId);
      if (res.success) {
        loadData();
      } else {
        alert(res.error || 'Failed to void purchase return.');
      }
    }
  };

  const filteredReturns = returns.filter(
    (r) =>
      r.returnNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      r.supplierName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (r.purchaseNumber && r.purchaseNumber.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-2 bg-amber-50 rounded-lg text-amber-600">
              <RotateCcw className="w-5 h-5" />
            </div>
            <h1 className="text-xl font-bold text-slate-800">Purchase Return (Debit Note)</h1>
          </div>
          <p className="text-sm text-slate-500 mt-1 pl-9">
            Return goods to supplier, reduce stock counts (Stock OUT), and adjust supplier payable debt.
          </p>
        </div>
        <button
          onClick={() => {
            resetForm();
            setIsModalOpen(true);
          }}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-600 text-white font-medium text-sm rounded-lg hover:bg-amber-700 transition-colors shadow-sm"
        >
          <Plus className="w-4 h-4" />
          Create Purchase Return
        </button>
      </div>

      {/* Search & Filter */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search return #, supplier name, or bill #..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
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
                <th className="px-5 py-3.5">Supplier</th>
                <th className="px-5 py-3.5">Ref Purchase Bill</th>
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
                    No purchase returns recorded yet.
                  </td>
                </tr>
              ) : (
                filteredReturns.map((ret) => (
                  <tr key={ret.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="px-5 py-3.5 font-semibold text-amber-700">{ret.returnNumber}</td>
                    <td className="px-5 py-3.5 text-slate-600">{ret.date}</td>
                    <td className="px-5 py-3.5 font-medium text-slate-800">{ret.supplierName}</td>
                    <td className="px-5 py-3.5 text-slate-500">{ret.purchaseNumber || '—'}</td>
                    <td className="px-5 py-3.5">
                      <span
                        className={`inline-flex px-2 py-0.5 text-xs font-semibold rounded-full ${
                          ret.type === 'CREDIT'
                            ? 'bg-amber-50 text-amber-700 border border-amber-200'
                            : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        }`}
                      >
                        {ret.type === 'CREDIT' ? 'Debit Note' : 'Cash Refund'}
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
                          onClick={() => handleOpenEditModal(ret)}
                          title="Edit Purchase Return"
                          className="p-1.5 text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded-md transition-colors"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(ret.id, ret.returnNumber)}
                          title="Void Purchase Return"
                          className="p-1.5 text-amber-500 hover:text-amber-700 hover:bg-amber-50 rounded-md transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot className="bg-slate-50 font-bold border-t-2 border-slate-200 text-slate-900">
              <tr>
                <td colSpan={5} className="px-5 py-3.5 text-right uppercase text-xs text-slate-500">Total ({filteredReturns.length} Returns):</td>
                <td className="px-5 py-3.5 text-right font-mono text-slate-900">
                  {filteredReturns.reduce((acc, r) => acc + (r.items || []).reduce((sum, i) => sum + i.quantity, 0), 0)} Pcs
                </td>
                <td className="px-5 py-3.5 text-right font-mono text-amber-700">
                  Rs. {filteredReturns.reduce((acc, r) => acc + r.grandTotal, 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* CREATE PURCHASE RETURN MODAL */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col my-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50 rounded-t-xl">
              <div className="flex items-center gap-2">
                <RotateCcw className="w-5 h-5 text-amber-600" />
                <h2 className="text-lg font-bold text-slate-800">
                  {editingReturn ? `Edit Purchase Return (${editingReturn.returnNumber})` : 'New Purchase Return (Stock OUT)'}
                </h2>
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
                  <SearchableSupplierSelect
                    suppliers={suppliers}
                    selectedSupplierId={selectedSupplierId}
                    onSelect={handleSupplierSelect}
                    currencySymbol={currencySymbol}
                    label="Supplier *"
                    placeholder="Search supplier name, code, phone..."
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Original Purchase Bill (Optional)</label>
                  <select
                    value={selectedPurchaseId}
                    onChange={(e) => handlePurchaseSelect(e.target.value)}
                    className="w-full min-h-[42px] px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                  >
                    <option value="">Manual / No Bill link</option>
                    {purchases.map((pur) => (
                      <option key={pur.id} value={pur.id}>
                        {pur.purchaseNumber} - {pur.supplierName} ({currencySymbol} {pur.grandTotal})
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
                    className="w-full min-h-[42px] px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
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
                          ? 'bg-amber-50 border-amber-500 text-amber-700'
                          : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      Debit Note (Reduce Payable)
                    </button>
                    <button
                      type="button"
                      onClick={() => setReturnType('CASH')}
                      className={`px-3 py-2 rounded-lg text-xs font-semibold border text-center transition-colors ${
                        returnType === 'CASH'
                          ? 'bg-amber-50 border-amber-500 text-amber-700'
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
                    placeholder="e.g. Damaged goods, expired stock, over-supplied"
                    className="w-full min-h-[42px] px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                  />
                </div>
              </div>

              {/* Items Section */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-bold text-slate-800">Returned Line Items (Stock Deduction)</h3>
                  <button
                    type="button"
                    onClick={handleAddItemRow}
                    className="text-xs font-semibold text-amber-600 hover:text-amber-700 inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Item Row
                  </button>
                </div>

                <div className="border border-slate-200 rounded-lg overflow-visible">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-100 border-b border-slate-200 text-slate-600 font-semibold">
                      <tr>
                        <th className="px-3 py-2">Product Item (Search Name / Code)</th>
                        <th className="px-3 py-2 w-20">Unit</th>
                        <th className="px-3 py-2 w-24 text-right">Qty</th>
                        <th className="px-3 py-2 w-32 text-right">Unit Cost ({currencySymbol})</th>
                        <th className="px-3 py-2 w-32 text-right">Total</th>
                        <th className="px-2 py-2 w-10 text-center"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {items.map((item, idx) => (
                        <tr key={idx} className="bg-white hover:bg-slate-50/50">
                          <td className="px-3 py-2">
                            <SearchableProductSelect
                              id={`purchase-return-product-search-${idx}`}
                              products={products}
                              selectedProductId={item.productId}
                              onSelect={(prodId) => handleProductSelect(idx, prodId)}
                              currencySymbol={currencySymbol}
                              priceType="COST"
                              placeholder="Type product name, code, barcode to search..."
                            />
                          </td>
                          <td className="px-3 py-2 text-slate-500 font-medium">{item.unit || 'Pcs'}</td>
                          <td className="px-3 py-2">
                            <input
                              id={`purchase-return-qty-input-${idx}`}
                              type="number"
                              min="1"
                              value={item.quantity || ''}
                              onChange={(e) => handleItemChange(idx, 'quantity', Number(e.target.value) || 0)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  if (idx === items.length - 1) {
                                    handleAddItemRow();
                                  } else {
                                    const nextInput = document.getElementById(`purchase-return-product-search-${idx + 1}`) as HTMLInputElement | null;
                                    if (nextInput) nextInput.focus();
                                  }
                                }
                              }}
                              className="w-full px-2 py-1.5 border border-slate-300 rounded-lg text-xs text-right font-mono font-bold focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={item.unitCost || ''}
                              onChange={(e) => handleItemChange(idx, 'unitCost', Number(e.target.value) || 0)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  if (idx === items.length - 1) {
                                    handleAddItemRow();
                                  } else {
                                    const nextInput = document.getElementById(`purchase-return-product-search-${idx + 1}`) as HTMLInputElement | null;
                                    if (nextInput) nextInput.focus();
                                  }
                                }
                              }}
                              className="w-full px-2 py-1.5 border border-slate-300 rounded-lg text-xs text-right font-mono font-bold focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                            />
                          </td>
                          <td className="px-3 py-2 text-right font-mono font-semibold text-slate-800">
                            {currencySymbol} {item.total.toFixed(2)}
                          </td>
                          <td className="px-2 py-2 text-center">
                            <button
                              type="button"
                              onClick={() => handleRemoveItemRow(idx)}
                              disabled={items.length === 1 && !item.productId}
                              className="text-slate-400 hover:text-amber-600 p-1 rounded hover:bg-amber-50 disabled:opacity-30 cursor-pointer"
                              title="Remove item"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      ))}
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
                    <span className="font-mono text-amber-700">Rs. {calculateGrandTotal().toFixed(2)}</span>
                  </div>
                </div>
              </div>

              {/* Notes */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Notes / Remarks</label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Additional details..."
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
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
                  className="px-5 py-2 bg-amber-600 text-white font-medium text-xs rounded-lg hover:bg-amber-700 disabled:opacity-50"
                >
                  {isSaving ? (editingReturn ? 'Updating...' : 'Processing Return...') : (editingReturn ? 'Update Purchase Return' : 'Save Purchase Return')}
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
                <span className="text-xs font-semibold text-amber-600 uppercase tracking-wider">Debit Note Voucher</span>
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
                <span className="text-slate-500 block">Supplier</span>
                <span className="font-bold text-slate-800 text-sm">{viewingReturn.supplierName}</span>
              </div>
              <div>
                <span className="text-slate-500 block">Return Date</span>
                <span className="font-semibold text-slate-800">{viewingReturn.date}</span>
              </div>
              <div>
                <span className="text-slate-500 block">Ref Purchase Bill</span>
                <span className="font-semibold text-slate-800">{viewingReturn.purchaseNumber || 'Manual Return'}</span>
              </div>
              <div>
                <span className="text-slate-500 block">Return Mode</span>
                <span className="font-semibold text-amber-700">{viewingReturn.type}</span>
              </div>
            </div>

            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
                  <tr>
                    <th className="px-3 py-2">Item</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Cost</th>
                    <th className="px-3 py-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {(viewingReturn.items || []).map((item, idx) => (
                    <tr key={idx}>
                      <td className="px-3 py-2 font-medium text-slate-800">{item.productName} ({item.productCode})</td>
                      <td className="px-3 py-2 text-right font-mono">{item.quantity} {item.unit}</td>
                      <td className="px-3 py-2 text-right font-mono">Rs. {item.unitCost.toFixed(2)}</td>
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
                <span className="text-lg font-bold text-amber-700 font-mono">
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
