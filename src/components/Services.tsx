import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

type Service = {
  id: string;
  category: string;
  description: string;
  typical_duration_minutes: number;
  price_uah: number;
  symptom_keywords: string[];
  active: boolean;
};

export default function Services() {
  const [services, setServices] = useState<Service[]>([]);
  const [editingService, setEditingService] = useState<Partial<Service> | null>(null);

  useEffect(() => {
    fetchServices();
  }, []);

  const fetchServices = async () => {
    const { data } = await supabase.from('services_kb').select('*').order('active', { ascending: false }).order('category');
    setServices(data || []);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editingService?.id) {
      await supabase.from('services_kb').update(editingService).eq('id', editingService.id);
    } else {
      await supabase.from('services_kb').insert([editingService]);
    }
    setEditingService(null);
    fetchServices();
  };

  return (
    <div className="p-4">
      <div className="flex justify-between mb-4">
        <h2 className="text-xl font-bold">Послуги</h2>
        <button onClick={() => setEditingService({ active: true, symptom_keywords: [] })} className="p-2 bg-blue-600 text-white rounded">+ Додати послугу</button>
      </div>
      <div className="grid gap-2">
        {services.map(s => (
          <div key={s.id} className={`border p-4 rounded flex justify-between ${s.active ? 'bg-white' : 'bg-gray-100 opacity-70'}`}>
            <div onClick={() => setEditingService(s)} className="cursor-pointer">
              <h3 className="font-bold">{s.category}</h3>
              <p className="text-sm">{s.description}</p>
              <p className="text-sm text-gray-500">{s.typical_duration_minutes} хв • {s.price_uah} грн</p>
              <div className="flex gap-1 mt-2">
                {s.symptom_keywords?.map(k => <span key={k} className="bg-blue-50 text-blue-800 text-xs px-2 py-1 rounded">{k}</span>)}
              </div>
            </div>
            <button onClick={() => supabase.from('services_kb').update({ active: !s.active }).eq('id', s.id).then(fetchServices)} className="p-1 text-xs border rounded">
              {s.active ? 'Деактивувати' : 'Активувати'}
            </button>
          </div>
        ))}
      </div>
      {editingService && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4">
          <form onSubmit={handleSave} className="bg-white p-4 rounded w-full max-w-md">
            <h2 className="text-lg font-bold mb-4">{editingService.id ? 'Редагувати' : 'Додати'} послугу</h2>
            <input placeholder="Категорія" value={editingService.category || ''} onChange={e => setEditingService({...editingService, category: e.target.value})} className="w-full p-2 mb-2 border rounded" required />
            <textarea placeholder="Опис" value={editingService.description || ''} onChange={e => setEditingService({...editingService, description: e.target.value})} className="w-full p-2 mb-2 border rounded" />
            <input type="number" placeholder="Хвилини" value={editingService.typical_duration_minutes || ''} onChange={e => setEditingService({...editingService, typical_duration_minutes: parseInt(e.target.value)})} className="w-full p-2 mb-2 border rounded" />
            <input type="number" placeholder="Ціна (грн)" value={editingService.price_uah || ''} onChange={e => setEditingService({...editingService, price_uah: parseInt(e.target.value)})} className="w-full p-2 mb-2 border rounded" />
            <input placeholder="Ключові слова (через кому)" value={editingService.symptom_keywords?.join(', ') || ''} onChange={e => setEditingService({...editingService, symptom_keywords: e.target.value.split(',').map(s => s.trim())})} className="w-full p-2 mb-2 border rounded" />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEditingService(null)} className="p-2 bg-gray-200 rounded">Скасувати</button>
              <button type="submit" className="p-2 bg-blue-600 text-white rounded">Зберегти</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
