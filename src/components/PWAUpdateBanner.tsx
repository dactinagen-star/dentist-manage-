import React, { useState, useEffect } from 'react';

export const PWAUpdateBanner = () => {
  const [showBanner, setShowBanner] = useState(false);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    const handleUpdateAvailable = (event: any) => {
      setRegistration(event.detail);
      setShowBanner(true);
    };

    window.addEventListener('sw-update-available', handleUpdateAvailable);
    return () => window.removeEventListener('sw-update-available', handleUpdateAvailable);
  }, []);

  const handleUpdate = () => {
    registration?.waiting?.postMessage({ type: 'SKIP_WAITING' });
    setShowBanner(false);
  };

  if (!showBanner) return null;

  return (
    <div className="fixed top-4 right-4 z-50 p-4 bg-blue-600 text-white rounded shadow-lg flex items-center gap-4">
      <p>Доступна нова версія застосунку</p>
      <button onClick={handleUpdate} className="bg-white text-blue-600 px-3 py-1 rounded font-bold hover:bg-blue-50">
        Оновити
      </button>
    </div>
  );
};
