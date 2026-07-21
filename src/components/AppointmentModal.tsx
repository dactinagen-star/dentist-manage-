import { useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

export default function AppointmentModal({ appointment, onClose, onUpdate }: { appointment: any, onClose: () => void, onUpdate: () => void }) {
  const [status, setStatus] = useState(appointment.status);
  const [notes, setNotes] = useState(appointment.notes || '');
  const [requestedTime, setRequestedTime] = useState(
    formatInTimeZone(new Date(appointment.requested_time), 'Europe/Kyiv', "yyyy-MM-dd'T'HH:mm")
  );

  const handleUpdate = async () => {
    await supabase.from('appointments').update({ 
        status, 
        notes,
        requested_time: fromZonedTime(requestedTime, 'Europe/Kyiv').toISOString()
    }).eq('id', appointment.id);
    onUpdate();
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
      <div className="bg-white p-4 rounded w-96">
        <h2 className="text-lg font-bold mb-4">Редагувати запис</h2>
        <p className="mb-2">Пацієнт: {appointment.patient_name}</p>
        <input 
            type="datetime-local" 
            value={requestedTime} 
            onChange={(e) => setRequestedTime(e.target.value)} 
            className="w-full p-2 mb-2 border rounded" 
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="w-full p-2 mb-2 border rounded">
          <option value="pending">Очікує</option>
          <option value="confirmed">Підтверджено</option>
          <option value="declined">Відхилено</option>
          <option value="completed">Завершено</option>
          <option value="cancelled">Скасовано</option>
        </select>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full p-2 mb-2 border rounded" placeholder="Примітки" />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="p-2 bg-gray-200 rounded">Скасувати</button>
          <button onClick={handleUpdate} className="p-2 bg-blue-600 text-white rounded">Зберегти</button>
        </div>
      </div>
    </div>
  );
}
