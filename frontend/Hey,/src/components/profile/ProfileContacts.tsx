// components/profile/ProfileContacts.tsx
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authService } from '@/services/auth.service';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import showToast from '@/lib/toast';
import { Phone, MessageCircle, Instagram, Facebook, Twitter, Linkedin, Mail, Globe, Trash2, Plus, CheckCircle, XCircle } from 'lucide-react';
import type { UserContact } from '@/types/models';

const CONTACT_TYPES = [
  { value: 'email_secondary', label: 'Secondary Email', icon: Mail },
  { value: 'whatsapp', label: 'WhatsApp', icon: MessageCircle },
  { value: 'phone', label: 'Phone', icon: Phone },
  { value: 'telegram', label: 'Telegram', icon: MessageCircle },
  { value: 'signal', label: 'Signal', icon: MessageCircle },
  { value: 'instagram', label: 'Instagram', icon: Instagram },
  { value: 'facebook', label: 'Facebook', icon: Facebook },
  { value: 'twitter', label: 'Twitter/X', icon: Twitter },
  { value: 'linkedin', label: 'LinkedIn', icon: Linkedin },
  { value: 'custom', label: 'Custom', icon: Globe },
];

const getIcon = (type: string) => {
  const found = CONTACT_TYPES.find(t => t.value === type);
  if (found?.icon) return found.icon;
  return Globe;
};

interface ProfileContactsProps {
  userId: string;
}

export function ProfileContacts({ userId }: ProfileContactsProps) {
  const qc = useQueryClient();
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingContact, setEditingContact] = useState<UserContact | null>(null);
  const [formData, setFormData] = useState({
    type: 'phone',
    value: '',
    label: '',
    country_code: '',
    is_primary: false,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['user-contacts', userId],
    queryFn: () => authService.getUserContacts(),
  });

  const contacts: UserContact[] = (data as { contacts?: UserContact[] })?.contacts ?? [];

  const upsertMutation = useMutation({
    mutationFn: () => authService.upsertContact(formData),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-contacts', userId] });
      showToast.success(editingContact ? 'Contact updated' : 'Contact added');
      setShowAddModal(false);
      setEditingContact(null);
      resetForm();
    },
    onError: () => showToast.error('Failed to save contact'),
  });

  const deleteMutation = useMutation({
    mutationFn: (contactId: string) => authService.deleteContact(contactId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-contacts', userId] });
      showToast.success('Contact deleted');
    },
    onError: () => showToast.error('Failed to delete contact'),
  });

  const resetForm = () => {
    setFormData({
      type: 'phone',
      value: '',
      label: '',
      country_code: '',
      is_primary: false,
    });
  };

  const handleEdit = (contact: UserContact) => {
    setEditingContact(contact);
    setFormData({
      type: contact.type,
      value: contact.value,
      label: contact.label || '',
      country_code: contact.country_code || '',
      is_primary: contact.is_primary,
    });
    setShowAddModal(true);
  };

  const handleSubmit = () => {
    if (!formData.value.trim()) {
      showToast.error('Please enter a value');
      return;
    }
    upsertMutation.mutate();
  };

  return (
    <>
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-text-primary">Contact Methods</h2>
          <Button size="sm" variant="secondary" onClick={() => setShowAddModal(true)}>
            <Plus size={14} /> Add Contact
          </Button>
        </div>

        {isLoading && <div className="text-center py-4 text-text-secondary">Loading...</div>}

        {!isLoading && contacts.length === 0 && (
          <div className="text-center py-6 text-text-secondary border border-dashed border-border rounded-lg">
            <p className="text-sm">No contacts added yet</p>
            <p className="text-xs mt-1">Add phone, WhatsApp, email, or social media links</p>
          </div>
        )}

        <div className="space-y-2">
          {contacts.map((contact) => {
            const Icon = getIcon(contact.type);
            return (
              <div
                key={contact.id}
                className="flex items-center justify-between p-3 bg-surface-alt rounded-lg hover:bg-surface transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Icon size={18} className="text-text-secondary" />
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-text-primary">{contact.value}</p>
                      {contact.is_primary && (
                        <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded-full">Primary</span>
                      )}
                      {contact.is_verified && (
                        <CheckCircle size={12} className="text-success" />
                      )}
                    </div>
                    {contact.label && (
                      <p className="text-xs text-text-secondary">{contact.label}</p>
                    )}
                    <p className="text-xs text-text-secondary capitalize mt-0.5">
                      {CONTACT_TYPES.find(t => t.value === contact.type)?.label || contact.type}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => handleEdit(contact)}
                    className="p-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface transition-colors"
                  >
                    <Plus size={14} />
                  </button>
                  <button
                    onClick={() => {
                      if (confirm('Delete this contact?')) {
                        deleteMutation.mutate(contact.id);
                      }
                    }}
                    className="p-1.5 rounded-lg text-text-secondary hover:text-danger hover:bg-red-50 transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Add/Edit Contact Modal */}
      <Modal
        open={showAddModal}
        onClose={() => {
          setShowAddModal(false);
          setEditingContact(null);
          resetForm();
        }}
        title={editingContact ? 'Edit Contact' : 'Add Contact'}
      >
        <div className="space-y-4">
          <Select
            label="Contact Type"
            options={CONTACT_TYPES}
            value={formData.type}
            onChange={(e) => setFormData({ ...formData, type: e.target.value })}
          />

          {formData.type === 'phone' && (
            <Input
              label="Country Code"
              placeholder="e.g., +234, +1, +44"
              value={formData.country_code}
              onChange={(e) => setFormData({ ...formData, country_code: e.target.value })}
            />
          )}

          <Input
            label="Value"
            placeholder={
              formData.type === 'email_secondary' ? 'email@example.com' :
              formData.type === 'phone' ? '8012345678' :
              formData.type === 'whatsapp' ? '8012345678' :
              formData.type === 'instagram' ? '@username' :
              'Enter contact value'
            }
            value={formData.value}
            onChange={(e) => setFormData({ ...formData, value: e.target.value })}
          />

          <Input
            label="Label (optional)"
            placeholder="e.g., Work, Home, Emergency"
            value={formData.label}
            onChange={(e) => setFormData({ ...formData, label: e.target.value })}
          />

          <label className="flex items-center gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              className="w-4 h-4 accent-primary"
              checked={formData.is_primary}
              onChange={(e) => setFormData({ ...formData, is_primary: e.target.checked })}
            />
            <span className="text-sm text-text-primary">Set as primary contact</span>
          </label>

          <div className="flex gap-3 pt-2">
            <Button
              variant="secondary"
              fullWidth
              onClick={() => {
                setShowAddModal(false);
                setEditingContact(null);
                resetForm();
              }}
            >
              Cancel
            </Button>
            <Button fullWidth onClick={handleSubmit} loading={upsertMutation.isPending}>
              {editingContact ? 'Save Changes' : 'Add Contact'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}