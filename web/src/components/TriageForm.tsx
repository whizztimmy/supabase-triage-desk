import { useState } from 'react';
import { supabase } from '../supabase';
import { CATEGORIES, SEVERITIES } from '../types';
import type { TriageCategory, TriageSeverity } from '../types';

interface Props {
  issueId: number;
  userId: string;
  onSaved: () => void;
}

export default function TriageForm({ issueId, userId, onSaved }: Props) {
  const [category, setCategory] = useState<TriageCategory>('bug');
  const [severity, setSeverity] = useState<TriageSeverity>('normal');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setError(null);
    const { error: insertError } = await supabase.from('triage_notes').insert({
      issue_id: issueId,
      triaged_by: userId,
      category,
      severity,
      note: note.trim() || null,
    });
    setSaving(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setNote('');
    onSaved();
  };

  return (
    <form
      className="triage-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <select value={category} onChange={(event) => setCategory(event.target.value as TriageCategory)}>
        {CATEGORIES.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>

      <select value={severity} onChange={(event) => setSeverity(event.target.value as TriageSeverity)}>
        {SEVERITIES.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>

      <input
        type="text"
        value={note}
        placeholder="What the user actually needs, or what is missing to reproduce"
        onChange={(event) => setNote(event.target.value)}
      />

      <button type="submit" disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>

      {error && <span className="error">{error}</span>}
    </form>
  );
}
