import { type ReactNode, type ButtonHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';

export function Spinner({ className = '', size = 20 }: { className?: string; size?: number }) {
  return <Loader2 className={`animate-spin ${className}`} size={size} />;
}

export function ScreenLoader({ label = 'جارٍ التحميل...', fullScreen = false }: { label?: string; fullScreen?: boolean }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-3 text-ink-400 ${fullScreen ? 'min-h-screen' : 'py-20'}`}>
      <Spinner className="text-brand-400" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

export function Card({
  children,
  className = '',
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`rounded-2xl bg-ink-970 border border-ink-800 p-4 ${onClick ? 'cursor-pointer active:scale-[0.99] transition-transform' : ''} ${className}`}
    >
      {children}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  size = 'md',
  disabled,
  className = '',
  type = 'button',
  ...attributes
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const variants = {
    primary: 'bg-brand-500 text-ink-950 hover:bg-brand-400 font-semibold',
    secondary: 'bg-ink-800 text-ink-100 hover:bg-ink-700 border border-ink-700',
    ghost: 'text-ink-300 hover:text-ink-100 hover:bg-ink-800',
    danger: 'bg-danger-500 text-white hover:bg-danger-400 font-semibold',
  };
  const sizes = {
    sm: 'px-3 py-1.5 text-sm rounded-lg',
    md: 'px-4 py-2.5 text-sm rounded-xl',
    lg: 'px-5 py-3 text-base rounded-xl',
  };
  return (
    <button
      {...attributes}
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${variants[variant]} ${sizes[size]} transition-all active:scale-95 disabled:opacity-40 disabled:active:scale-100 ${className}`}
    >
      {children}
    </button>
  );
}

export function Badge({
  children,
  color = 'neutral',
}: {
  children: ReactNode;
  color?: 'neutral' | 'brand' | 'warning' | 'danger' | 'accent';
}) {
  const colors = {
    neutral: 'bg-ink-800 text-ink-300',
    brand: 'bg-brand-500/15 text-brand-300',
    warning: 'bg-warning-500/15 text-warning-400',
    danger: 'bg-danger-500/15 text-danger-400',
    accent: 'bg-accent-500/15 text-accent-400',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${colors[color]}`}>
      {children}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  subtitle,
  action,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 px-6 text-center">
      <div className="w-16 h-16 rounded-2xl bg-ink-800 flex items-center justify-center text-ink-500">
        {icon}
      </div>
      <div>
        <p className="text-ink-200 font-medium">{title}</p>
        {subtitle && <p className="text-ink-500 text-sm mt-1">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Input({
  value,
  onChange,
  placeholder,
  type = 'text',
  className = '',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'password';
  className?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      dir="ltr"
      className={`w-full rounded-xl bg-ink-900 border border-ink-700 px-3.5 py-2.5 text-sm text-ink-100 placeholder:text-ink-600 focus:outline-none focus:border-brand-500 ${className}`}
    />
  );
}

export function Select({
  value,
  onChange,
  options,
  className = '',
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full rounded-xl bg-ink-900 border border-ink-700 px-3.5 py-2.5 text-sm text-ink-100 focus:outline-none focus:border-brand-500 ${className}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-xl bg-danger-500/10 border border-danger-500/30 px-4 py-3 text-sm text-danger-400">
      {message}
    </div>
  );
}
