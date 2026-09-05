import React, { useState, useEffect } from 'react';
import {
  BookOpen,
  Plus,
  Search,
  Printer,
  Eye,
  Pencil,
  Trash2,
  Calendar,
  AlertCircle,
  X,
  CheckCircle2,
  HelpCircle,
  ArrowRightLeft
} from 'lucide-react';
import { StorageService } from '../lib/storage';
import { JournalEntry, JournalLine, Customer, Supplier, LedgerAccount } from '../types';

interface JournalManagementProps {
  currentCompanyId: string;
}

export const JournalManagement: React.FC<JournalManagementProps> = ({ currentCompanyId }) => {
  const [journals, setJournals] = useState<JournalEntry[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [ledgers, setLedgers] = useState<LedgerAccount[]>([]);

  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingJournalId, setEditingJournalId] = useState<string | null>(null);
  const [viewingJournal, setViewingJournal] = useState<JournalEntry | null>(null);

  // Form state
  const [voucherDate, setVoucherDate] = useState(new Date().toISOString().split('T')[0]);
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState<Array<{
    id: string;
    ledgerId: string;
    ledgerName: string;
    particulars: string;
    debit: number;
    credit: number;
  }>>([
    { id: '1', ledgerId: '', ledgerName: '', particulars: '', debit: 0, credit: 0 },
    { id: '2', ledgerId: '', ledgerName: '', particulars: '', debit: 0, credit: 0 }
  ]);

  const [isSaving, setIsSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    loadData();
  }, [currentCompanyId]);

  const loadData = () => {
    setJournals(StorageService.getJournalEntries(currentCompanyId));
    setCustomers(StorageService.getCustomers(currentCompanyId));
    setSuppliers(StorageService.getSuppliers(currentCompanyId));
    setLedgers(StorageService.getLedgers(currentCompanyId));
  };

  // Compile full accounts list for dropdown
  const accountOptions = [
    { category: 'Customers (Debtors)', items: customers.map((c) => ({ id: c.id, name: c.name, type: 'Customer' })) },
    { category: 'Suppliers (Creditors)', items: suppliers.map((s) => ({ id: s.id, name: s.name, type: 'Supplier' })) },
    {
      category: 'General Accounts',
      items: [
        { id: 'sys-cash', name: 'Cash Account', type: 'Cash' },
        { id: 'sys-bank', name: 'Bank Account', type: 'Bank' },
        { id: 'sys-sales', name: 'Sales Account', type: 'Revenue' },
        { id: 'sys-purchases', name: 'Purchase Account', type: 'Expense' },
        { id: 'sys-sales-return', name: 'Sales Return Account', type: 'Revenue' },
        { id: 'sys-purchase-return', name: 'Purchase Return Account', type: 'Expense' },
        { id: 'sys-discount-allowed', name: 'Discount Allowed', type: 'Expense' },
        { id: 'sys-discount-received', name: 'Discount Received', type: 'Income' },
        { id: 'sys-capital', name: 'Capital Account', type: 'Equity' },
        { id: 'sys-drawing', name: 'Owner Drawings Account', type: 'Equity' },
        { id: 'sys-tax', name: 'VAT / Tax Payable Account', type: 'Liability' }
      ]
    },
    {
      category: 'Custom Ledgers',
      items: ledgers.map((l) => ({ id: l.id, name: l.accountName, type: l.accountGroup }))
    }
  ];

  const handleAddLine = () => {
    setLines((prev) => [
      ...prev,
      {
        id: String(Date.now() + Math.random()),
        ledgerId: '',
        ledgerName: '',
        particulars: '',
        debit: 0,
        credit: 0
      }
    ]);
  };

  const handleLineChange = (index: number, field: string, value: any) => {
    setLines((prev) => {
      const updated = [...prev];
      const line = { ...updated[index] };
      if (field === 'ledger') {
        // Find in accountOptions
        let foundName = value;
        for (const cat of accountOptions) {
          const matched = cat.items.find((i) => i.id === value || i.name === value);
          if (matched) {
            line.ledgerId = matched.id;
            line.ledgerName = matched.name;
            foundName = matched.name;
            break;
          }
        }
        if (!line.ledgerName) {
          line.ledgerId = value;
          line.ledgerName = value;
        }
      } else if (field === 'particulars') {
        line.particulars = value;
      } else if (field === 'debit') {
        line.debit = Math.max(0, Number(value) || 0);
        if (line.debit > 0) line.credit = 0; // Double entry helper: if Debit typed, clear Credit
      } else if (field === 'credit') {
        line.credit = Math.max(0, Number(value) || 0);
        if (line.credit > 0) line.debit = 0; // Double entry helper: if Credit typed, clear Debit
      }
      updated[index] = line;
      return updated;
    });
  };

  const handleRemoveLine = (index: number) => {
    if (lines.length <= 2) {
      setFeedback({ type: 'error', message: 'A journal voucher requires at least 2 entry lines.' });
      return;
    }
    setLines((prev) => prev.filter((_, i) => i !== index));
  };

  const totalDebit = lines.reduce((sum, l) => sum + Number(l.debit || 0), 0);
  const totalCredit = lines.reduce((sum, l) => sum + Number(l.credit || 0), 0);
  const difference = Math.abs(totalDebit - totalCredit);
  const isBalanced = difference < 0.01 && totalDebit > 0;

  const resetForm = () => {
    setEditingJournalId(null);
    setVoucherDate(new Date().toISOString().split('T')[0]);
    setNarration('');
    setLines([
      { id: '1', ledgerId: '', ledgerName: '', particulars: '', debit: 0, credit: 0 },
      { id: '2', ledgerId: '', ledgerName: '', particulars: '', debit: 0, credit: 0 }
    ]);
    setFeedback(null);
  };

  const handleEdit = (j: JournalEntry) => {
    setEditingJournalId(j.id);
    setVoucherDate(j.voucherDate);
    setNarration(j.narration || '');
    setLines(
      (j.lines || []).map((l, i) => ({
        id: l.id || String(i),
        ledgerId: l.ledgerId,
        ledgerName: l.ledgerName,
        particulars: l.particulars || '',
        debit: l.debit || 0,
        credit: l.credit || 0
      }))
    );
    setIsModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this journal entry?')) return;
    const res = await StorageService.deleteJournalEntryAsync(id, currentCompanyId);
    if (res.success) {
      loadData();
    } else {
      alert(res.error || 'Failed to delete journal entry.');
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isBalanced) {
      setFeedback({
        type: 'error',
        message: `Journal entry is out of balance! Debit (Rs. ${totalDebit.toFixed(2)}) must equal Credit (Rs. ${totalCredit.toFixed(2)}). Difference: Rs. ${difference.toFixed(2)}`
      });
      return;
    }

    const invalidLine = lines.find((l) => !l.ledgerName || (l.debit === 0 && l.credit === 0));
    if (invalidLine) {
      setFeedback({
        type: 'error',
        message: 'All lines must have a valid Account selected and a Debit or Credit amount.'
      });
      return;
    }

    setIsSaving(true);
    setFeedback(null);

    const formattedLines: JournalLine[] = lines.map((l, i) => ({
      id: l.id || `line-${i}`,
      ledgerId: l.ledgerId || l.ledgerName,
      ledgerName: l.ledgerName,
      debit: l.debit,
      credit: l.credit,
      particulars: l.particulars || narration
    }));

    if (editingJournalId) {
      const result = await StorageService.updateJournalEntryAsync(
        editingJournalId,
        {
          voucherDate,
          narration: narration || 'Manual double entry adjustment',
          lines: formattedLines,
          debitTotal: totalDebit,
          creditTotal: totalCredit
        },
        currentCompanyId
      );

      setIsSaving(false);
      if (result.success) {
        loadData();
        setIsModalOpen(false);
        resetForm();
      } else {
        setFeedback({ type: 'error', message: result.error || 'Failed to update journal voucher.' });
      }
      return;
    }

    const count = journals.length + 1;
    const voucherNo = `JV-${new Date().getFullYear()}-${String(count).padStart(4, '0')}`;

    const result = await StorageService.createJournalEntryAsync(
      {
        companyId: currentCompanyId,
        voucherNo,
        voucherDate,
        voucherType: 'Journal Voucher',
        narration: narration || 'Manual double entry adjustment',
        lines: formattedLines,
        debitTotal: totalDebit,
        creditTotal: totalCredit,
        status: 'POSTED'
      },
      currentCompanyId
    );

    setIsSaving(false);

    if (result.success) {
      loadData();
      setIsModalOpen(false);
      resetForm();
    } else {
      setFeedback({ type: 'error', message: result.error || 'Failed to save journal voucher.' });
    }
  };

  const filteredJournals = journals.filter(
    (j) =>
      j.voucherNo.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (j.narration && j.narration.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (j.lines || []).some((l) => l.ledgerName.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-2 bg-indigo-50 rounded-lg text-indigo-600">
              <BookOpen className="w-5 h-5" />
            </div>
            <h1 className="text-xl font-bold text-slate-800">Journal (Manual Double Entry)</h1>
          </div>
          <p className="text-sm text-slate-500 mt-1 pl-9">
            Record manual accounting adjustments, opening balances, non-cash entries, and inter-ledger transfers.
          </p>
        </div>
        <button
          onClick={() => {
            resetForm();
            setIsModalOpen(true);
          }}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 text-white font-medium text-sm rounded-lg hover:bg-indigo-700 transition-colors shadow-sm"
        >
          <Plus className="w-4 h-4" />
          Create Journal Entry (JV)
        </button>
      </div>

      {/* Search & Info Bar */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search JV #, narration, or account name..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
          />
        </div>
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
          Total Vouchers: {journals.length}
        </div>
      </div>

      {/* Journal Vouchers Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                <th className="px-5 py-3.5">Voucher No</th>
                <th className="px-5 py-3.5">Date</th>
                <th className="px-5 py-3.5">Narration / Accounts</th>
                <th className="px-5 py-3.5 text-right">Debit Total</th>
                <th className="px-5 py-3.5 text-right">Credit Total</th>
                <th className="px-5 py-3.5 text-center">Status</th>
                <th className="px-5 py-3.5 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {filteredJournals.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-slate-400">
                    <BookOpen className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                    No manual journal entries recorded yet.
                  </td>
                </tr>
              ) : (
                filteredJournals.map((j) => (
                  <tr key={j.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="px-5 py-3.5 font-semibold text-indigo-600">{j.voucherNo}</td>
                    <td className="px-5 py-3.5 text-slate-600">{j.voucherDate}</td>
                    <td className="px-5 py-3.5">
                      <div className="font-medium text-slate-800">{j.narration || 'Journal Voucher'}</div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        {(j.lines || []).map((l) => l.ledgerName).join(' | ')}
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-right font-mono font-bold text-slate-800">
                      Rs. {(j.debitTotal || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-5 py-3.5 text-right font-mono font-bold text-slate-800">
                      Rs. {(j.creditTotal || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-5 py-3.5 text-center">
                      <span className="inline-flex px-2 py-0.5 text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full">
                        POSTED
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center justify-center gap-2">
                        <button
                          onClick={() => setViewingJournal(j)}
                          title="View JV"
                          className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md transition-colors"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleEdit(j)}
                          title="Edit JV"
                          className="p-1.5 text-slate-500 hover:text-amber-600 hover:bg-slate-100 rounded-md transition-colors"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(j.id)}
                          title="Delete JV"
                          className="p-1.5 text-slate-500 hover:text-rose-600 hover:bg-rose-50 rounded-md transition-colors"
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

      {/* CREATE JOURNAL MODAL */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm overflow-y-auto">
          <div className="bg-white rounded-xl border border-slate-200 shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col my-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50 rounded-t-xl">
              <div className="flex items-center gap-2">
                <ArrowRightLeft className="w-5 h-5 text-indigo-600" />
                <h2 className="text-lg font-bold text-slate-800">New Journal Entry (Double Entry)</h2>
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

              {/* Date & Narration */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Voucher Date *</label>
                  <input
                    type="date"
                    value={voucherDate}
                    onChange={(e) => setVoucherDate(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    required
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Overall Narration / Note *</label>
                  <input
                    type="text"
                    value={narration}
                    onChange={(e) => setNarration(e.target.value)}
                    placeholder="e.g. Adjustment entry for depreciation, transfer, or opening balances"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    required
                  />
                </div>
              </div>

              {/* Dynamic Double Entry Lines */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-bold text-slate-800">Double Entry Ledger Lines</h3>
                  <button
                    type="button"
                    onClick={handleAddLine}
                    className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 inline-flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Line
                  </button>
                </div>

                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-100 border-b border-slate-200 text-slate-600 font-semibold">
                      <tr>
                        <th className="px-3 py-2">Account / Party</th>
                        <th className="px-3 py-2">Line Particulars</th>
                        <th className="px-3 py-2 w-32 text-right">Debit (Dr)</th>
                        <th className="px-3 py-2 w-32 text-right">Credit (Cr)</th>
                        <th className="px-2 py-2 w-10 text-center"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {lines.map((line, idx) => (
                        <tr key={line.id} className="bg-white">
                          <td className="px-3 py-2">
                            <select
                              value={line.ledgerId || line.ledgerName}
                              onChange={(e) => handleLineChange(idx, 'ledger', e.target.value)}
                              className="w-full px-2 py-1.5 border border-slate-300 rounded text-xs focus:outline-none focus:border-indigo-500"
                              required
                            >
                              <option value="">Select Account / Customer / Supplier...</option>
                              {accountOptions.map((group) => (
                                <optgroup key={group.category} label={group.category}>
                                  {group.items.map((opt) => (
                                    <option key={opt.id} value={opt.id}>
                                      {opt.name} ({opt.type})
                                    </option>
                                  ))}
                                </optgroup>
                              ))}
                            </select>
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="text"
                              value={line.particulars}
                              onChange={(e) => handleLineChange(idx, 'particulars', e.target.value)}
                              placeholder="Line note..."
                              className="w-full px-2 py-1 border border-slate-300 rounded text-xs focus:outline-none focus:border-indigo-500"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={line.debit || ''}
                              onChange={(e) => handleLineChange(idx, 'debit', e.target.value)}
                              placeholder="0.00"
                              className="w-full px-2 py-1 border border-slate-300 rounded text-xs text-right font-mono focus:outline-none focus:border-indigo-500 font-semibold text-slate-800"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={line.credit || ''}
                              onChange={(e) => handleLineChange(idx, 'credit', e.target.value)}
                              placeholder="0.00"
                              className="w-full px-2 py-1 border border-slate-300 rounded text-xs text-right font-mono focus:outline-none focus:border-indigo-500 font-semibold text-slate-800"
                            />
                          </td>
                          <td className="px-2 py-2 text-center">
                            <button
                              type="button"
                              onClick={() => handleRemoveLine(idx)}
                              className="text-slate-400 hover:text-rose-600 p-1"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Double Entry Balance Verification Bar */}
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 flex flex-col sm:flex-row items-center justify-between gap-4">
                <div className="flex items-center gap-4 text-xs">
                  <div>
                    <span className="text-slate-500 block">Total Debit:</span>
                    <span className="text-sm font-bold text-slate-900 font-mono">
                      Rs. {totalDebit.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                  <div className="h-8 w-px bg-slate-200"></div>
                  <div>
                    <span className="text-slate-500 block">Total Credit:</span>
                    <span className="text-sm font-bold text-slate-900 font-mono">
                      Rs. {totalCredit.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>

                <div>
                  {isBalanced ? (
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-full border border-emerald-200">
                      <CheckCircle2 className="w-4 h-4" />
                      Journal Balanced (Dr = Cr)
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-700 bg-rose-50 px-3 py-1.5 rounded-full border border-rose-200">
                      <AlertCircle className="w-4 h-4" />
                      Unbalanced Difference: Rs. {difference.toFixed(2)}
                    </div>
                  )}
                </div>
              </div>

              {/* Buttons */}
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
                  disabled={!isBalanced || isSaving}
                  className="px-5 py-2 bg-indigo-600 text-white font-medium text-xs rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                >
                  {isSaving ? 'Posting Journal...' : 'Post Journal Voucher'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* VIEW JOURNAL VOUCHER MODAL */}
      {viewingJournal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-xl border border-slate-200 shadow-xl max-w-2xl w-full p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-slate-200 pb-4">
              <div>
                <span className="text-xs font-semibold text-indigo-600 uppercase tracking-wider">Journal Voucher</span>
                <h2 className="text-xl font-bold text-slate-900">{viewingJournal.voucherNo}</h2>
              </div>
              <button
                onClick={() => setViewingJournal(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <span className="text-slate-500 block">Voucher Date</span>
                <span className="font-semibold text-slate-800">{viewingJournal.voucherDate}</span>
              </div>
              <div>
                <span className="text-slate-500 block">Narration</span>
                <span className="font-semibold text-slate-800">{viewingJournal.narration}</span>
              </div>
            </div>

            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
                  <tr>
                    <th className="px-3 py-2">Particulars / Account</th>
                    <th className="px-3 py-2 text-right">Debit (Dr)</th>
                    <th className="px-3 py-2 text-right">Credit (Cr)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 font-mono">
                  {(viewingJournal.lines || []).map((line, idx) => (
                    <tr key={idx}>
                      <td className="px-3 py-2 font-sans font-medium text-slate-800">{line.ledgerName}</td>
                      <td className="px-3 py-2 text-right">
                        {line.debit > 0 ? `Rs. ${line.debit.toFixed(2)}` : '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {line.credit > 0 ? `Rs. ${line.credit.toFixed(2)}` : '—'}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-slate-100 font-bold font-sans">
                    <td className="px-3 py-2 text-slate-900">Total</td>
                    <td className="px-3 py-2 text-right font-mono text-indigo-700">
                      Rs. {(viewingJournal.debitTotal || 0).toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-indigo-700">
                      Rs. {(viewingJournal.creditTotal || 0).toFixed(2)}
                    </td>
                  </tr>
                </tbody>
              </table>
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
