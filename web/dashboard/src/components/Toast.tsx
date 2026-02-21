import { useState, useCallback } from 'preact/hooks';

export interface ToastMessage {
  id: string;
  message: string;
  type: 'success' | 'error' | 'warning' | 'info';
}

interface ToastProps {
  toasts: ToastMessage[];
}

export function ToastContainer({ toasts }: ToastProps) {
  return (
    <div class="toast-container">
      {toasts.map(t => (
        <div key={t.id} class={`toast ${t.type}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}

export function useToast() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const showToast = useCallback(
    (message: string, type: ToastMessage['type'] = 'info', durationMs = 3000) => {
      const id = crypto.randomUUID();
      setToasts(prev => [...prev, { id, message, type }]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, durationMs);
    },
    [],
  );

  return { toasts, showToast };
}
