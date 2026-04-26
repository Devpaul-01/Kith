// components/ui/Checkbox.tsx
import { forwardRef, InputHTMLAttributes } from 'react';

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
  error?: string;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ label, error, checked, onCheckedChange, className = '', disabled, ...props }, ref) => {
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      if (onCheckedChange) {
        onCheckedChange(e.target.checked);
      }
    };

    return (
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            ref={ref}
            checked={checked}
            onChange={handleChange}
            disabled={disabled}
            className={`
              h-4 w-4 rounded border-gray-300 
              text-primary-600 focus:ring-primary-500
              disabled:cursor-not-allowed disabled:opacity-50
              ${className}
            `}
            {...props}
          />
          {label && (
            <span className={`
              text-sm font-medium
              ${disabled ? 'text-gray-400 cursor-not-allowed' : 'text-gray-700'}
            `}>
              {label}
            </span>
          )}
        </label>
        {error && (
          <p className="text-sm text-red-600">{error}</p>
        )}
      </div>
    );
  }
);

Checkbox.displayName = 'Checkbox';