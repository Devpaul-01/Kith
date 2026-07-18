// components/workspace/GeneralSettingsTab.tsx
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import type { Workspace } from '@/services/workspace.service';

const SUPPORTED_CURRENCIES = [
  { value: 'USD', label: 'USD - US Dollar' },
  { value: 'EUR', label: 'EUR - Euro' },
  { value: 'GBP', label: 'GBP - British Pound' },
  { value: 'NGN', label: 'NGN - Nigerian Naira' },
  { value: 'KES', label: 'KES - Kenyan Shilling' },
  { value: 'GHS', label: 'GHS - Ghanaian Cedi' },
  { value: 'ZAR', label: 'ZAR - South African Rand' },
  { value: 'JPY', label: 'JPY - Japanese Yen' },
  { value: 'CAD', label: 'CAD - Canadian Dollar' },
  { value: 'AUD', label: 'AUD - Australian Dollar' },
  { value: 'CHF', label: 'CHF - Swiss Franc' },
  { value: 'CNY', label: 'CNY - Chinese Yuan' },
  { value: 'INR', label: 'INR - Indian Rupee' },
  { value: 'BRL', label: 'BRL - Brazilian Real' },
];

const FAMILY_TYPES = [
  { value: 'nuclear', label: 'Nuclear Family' },
  { value: 'extended', label: 'Extended Family' },
  { value: 'blended', label: 'Blended Family' },
  { value: 'community', label: 'Community' },
  { value: 'association', label: 'Association' },
  { value: 'other', label: 'Other' },
];

const VISIBILITY_OPTIONS = [
  { value: 'private', label: 'Private - Only members can see this workspace' },
  { value: 'public', label: 'Public - Anyone can view (members only to contribute)' },
];

const generalSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(80),
  description: z.string().max(500).optional().nullable(),
  base_currency: z.string().min(1, 'Currency is required'),
  family_type: z.enum(['nuclear','extended','blended','community','association','other']),
  visibility: z.enum(['private', 'public']),
});

type GeneralForm = z.infer<typeof generalSchema>;

interface GeneralSettingsTabProps {
  workspace: Workspace;
  onUpdate: (payload: {
    name?: string;
    description?: string | null;
    base_currency?: string;
    family_type?: 'extended' | 'event' | 'pool';
    visibility?: 'private' | 'public';
  }) => void;
  isUpdating: boolean;
}

export function GeneralSettingsTab({ workspace, onUpdate, isUpdating }: GeneralSettingsTabProps) {
  const { register, handleSubmit, formState: { errors } } = useForm<GeneralForm>({
    resolver: zodResolver(generalSchema),
    defaultValues: {
      name: workspace.name,
      description: workspace.description,
      base_currency: workspace.base_currency,
      family_type: workspace.family_type,
      visibility: workspace.visibility,
    },
  });

  const onSubmit = (data: GeneralForm) => {
    onUpdate({
      name: data.name,
      description: data.description,
      base_currency: data.base_currency,
      family_type: data.family_type,
      visibility: data.visibility,
    });
  };

  return (
    <Card>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <Input
          label="Workspace Name"
          placeholder="My Family Workspace"
          error={errors.name?.message}
          {...register('name')}
        />

        <Textarea
          label="Description"
          placeholder="A brief description of your workspace"
          rows={2}
          {...register('description')}
        />

        <Select
          label="Base Currency"
          options={SUPPORTED_CURRENCIES}
          error={errors.base_currency?.message}
          {...register('base_currency')}
        />

        <Select
          label="Family Type"
          options={FAMILY_TYPES}
          error={errors.family_type?.message}
          {...register('family_type')}
        />

        <Select
          label="Visibility"
          options={VISIBILITY_OPTIONS}
          error={errors.visibility?.message}
          {...register('visibility')}
        />

        <div className="border-t border-border pt-4">
          <Button type="submit" loading={isUpdating}>
            Save Changes
          </Button>
        </div>
      </form>
    </Card>
  );
}