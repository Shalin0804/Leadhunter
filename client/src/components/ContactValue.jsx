import { useState } from 'react';
import { FiEye } from 'react-icons/fi';
import { leadApi } from '../services/endpoints';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

/**
 * Shows a contact value. Roles without `contacts.view_unmasked` receive it masked from
 * the API; clicking Reveal fetches the value from the audited reveal endpoint.
 */
export default function ContactValue({ contact, leadId, fallback = '—', render }) {
  const { can } = useAuth();
  const toast = useToast();
  const [value, setValue] = useState(null);
  const [busy, setBusy] = useState(false);

  if (!contact) return fallback;
  const shown = contact.masked ? value : contact.value;
  if (shown) return render ? render(shown) : shown;

  const reveal = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    try {
      const { contact: c } = await leadApi.revealContact(leadId, contact.id);
      setValue(c.value);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="masked-contact">
      <span className="text-muted">{contact.value_masked}</span>
      {leadId && can('contacts.reveal') && (
        <button type="button" className="btn btn-sm reveal-btn" onClick={reveal} disabled={busy} title="Reveal (this access is logged)">
          <FiEye /> {busy ? '…' : 'Reveal'}
        </button>
      )}
    </span>
  );
}
