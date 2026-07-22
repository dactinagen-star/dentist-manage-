import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { startOfWeek, endOfWeek, eachDayOfInterval, format, addWeeks, subWeeks } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { uk } from 'date-fns/locale';
import { motion, useAnimation } from 'framer-motion';
import { Copy, ChevronLeft, ChevronRight } from 'lucide-react';
import AppointmentModal from './AppointmentModal';

export default function Calendar() {
  const [appointments, setAppointments] = useState<any[]>([]);
  const [currentWeekStart, setCurrentWeekStart] = useState(startOfWeek(new Date(), { weekStartsOn: 1 }));
  const [selectedAppointment, setSelectedAppointment] = useState<any>(null);
  const [showNewAppointmentModal, setShowNewAppointmentModal] = useState(false);
  const [services, setServices] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [scale, setScale] = useState(1);
  const controls = useAnimation();

  const [newAppointment, setNewAppointment] = useState({ patient_name: '', service_category: '', requested_time: '', notes: '' });
  const [workingWindows, setWorkingWindows] = useState<any>({});

  useEffect(() => {
    fetchAppointments();
    fetchWorkingWindows();
    fetchServices();
  }, [currentWeekStart]);

  const fetchServices = async () => {
    const { data } = await supabase.from('services_kb').select('*').eq('active', true);
    setServices(data || []);
  };

  const fetchWorkingWindows = async () => {
    const windows: any = {};
    const days = eachDayOfInterval({
        start: currentWeekStart,
        end: endOfWeek(currentWeekStart, { weekStartsOn: 1 }),
      });
    
    for (const day of days) {
        const { data } = await supabase.rpc('get_working_window', { target_date: format(day, 'yyyy-MM-dd') });
        if (data) windows[format(day, 'yyyy-MM-dd')] = data;
    }
    setWorkingWindows(windows);
  };

  const fetchAppointments = async () => {
    const { data, error } = await supabase
      .from('appointments')
      .select('*')
      .gte('requested_time', currentWeekStart.toISOString())
      .lte('requested_time', endOfWeek(currentWeekStart, { weekStartsOn: 1 }).toISOString());
    
    if (error) console.error(error);
    else setAppointments(data || []);
  };

  const handleCreateAppointment = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsChecking(true);
    const service = services.find(s => s.category === newAppointment.service_category);
    const duration = service?.typical_duration_minutes || 30;

    const { data: isAvailable, error: checkError } = await supabase.rpc('check_availability', {
      requested_start: newAppointment.requested_time,
      duration_minutes: duration
    });

    if (checkError || !isAvailable) {
      setError("Цей час вже зайнятий");
      setIsChecking(false);
      return;
    }

    await supabase.from('appointments').insert([{
      ...newAppointment,
      telegram_id: 0,
      business_connection_id: 'manual',
      status: 'confirmed',
      estimated_duration_minutes: duration
    }]);
    setShowNewAppointmentModal(false);
    setIsChecking(false);
    setNewAppointment({ patient_name: '', service_category: '', requested_time: '', notes: '' });
    fetchAppointments();
  };

  const days = eachDayOfInterval({
    start: currentWeekStart,
    end: endOfWeek(currentWeekStart, { weekStartsOn: 1 }),
  });

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'confirmed': return 'bg-green-300';
      case 'cancelled': return 'bg-red-300';
      case 'declined': return 'bg-gray-400';
      case 'pending': return 'bg-blue-300';
      case 'completed': return 'bg-purple-300';
      default: return 'bg-gray-400';
    }
  };

  return (
    <div className="p-4">
      <div className="flex justify-between items-center mb-4">
        <button onClick={() => setShowNewAppointmentModal(true)} className="p-2 bg-green-600 text-white rounded">+ Новий запис</button>
        <div className="flex gap-2">
          <button onClick={() => setCurrentWeekStart(subWeeks(currentWeekStart, 1))} className="flex items-center gap-1 p-2 bg-blue-100 border border-blue-300 rounded-md hover:bg-blue-200 active:bg-transparent transition"><ChevronLeft size={16} /> Попередній</button>
          <button onClick={() => setCurrentWeekStart(addWeeks(currentWeekStart, 1))} className="flex items-center gap-1 p-2 bg-blue-100 border border-blue-300 rounded-md hover:bg-blue-200 active:bg-transparent transition">Наступний <ChevronRight size={16} /></button>
        </div>
        <h2 className="text-xl font-bold">{format(currentWeekStart, 'MMMM yyyy', { locale: uk })}</h2>
      </div>
      <div className="flex gap-4 mb-4 text-xs items-center flex-wrap">
        <div className="flex items-center gap-1"><div className="w-3 h-3 bg-green-300 rounded border border-gray-300"></div> Підтверджено</div>
        <div className="flex items-center gap-1"><div className="w-3 h-3 bg-purple-300 rounded border border-gray-300"></div> Завершено</div>
        <div className="flex items-center gap-1"><div className="w-3 h-3 bg-red-300 rounded border border-gray-300"></div> Скасовано пацієнтом</div>
        <div className="flex items-center gap-1"><div className="w-3 h-3 bg-gray-400 rounded border border-gray-300"></div> Відхилено вами</div>
        <div className="flex items-center gap-1"><div className="w-3 h-3 bg-blue-300 rounded border border-gray-300"></div> Очікується підтвердження</div>
        <div className="flex gap-2">
          <button onClick={() => {
              const newScale = scale + 0.1;
              setScale(newScale);
              controls.start({ scale: newScale });
          }} className="p-1 bg-blue-500 text-white rounded text-xs">Збільшити</button>
          <button onClick={() => {
              setScale(1);
              controls.start({ scale: 1, x: 0, y: 0 });
          }} className="p-1 bg-gray-500 text-white rounded text-xs">Скинути</button>
        </div>
      </div>
      <div className="relative overflow-auto border border-gray-200 rounded-lg p-2" style={{ cursor: 'grab' }}>
        <button onClick={() => {
          let text = "";
          days.forEach((day, index) => {
            text += `${format(day, 'EEEE, dd.MM', { locale: uk })}:\n`;
            
            const dayApps = appointments
              .filter(app => format(new Date(app.requested_time), 'yyyy-MM-dd') === format(day, 'yyyy-MM-dd'))
              .sort((a, b) => new Date(a.requested_time).getTime() - new Date(b.requested_time).getTime());

            if (dayApps.length === 0) {
              text += "• Немає записів\n";
            } else {
              dayApps.forEach(app => {
                const start = new Date(app.requested_time);
                const end = new Date(start.getTime() + app.estimated_duration_minutes * 60000);
                const timeStr = `${formatInTimeZone(start, 'Europe/Kyiv', 'HH:mm', { locale: uk })} - ${formatInTimeZone(end, 'Europe/Kyiv', 'HH:mm', { locale: uk })}`;
                text += `• ${timeStr} — ${app.patient_name}\n`;
              });
            }
            if (index < days.length - 1) text += "\n";
          });
          navigator.clipboard.writeText(text);
        }} className="absolute top-2 right-2 p-2 bg-gray-100 hover:bg-gray-200 rounded z-10">
          <Copy size={16} />
        </button>
        <motion.div
          drag
          dragConstraints={{ left: -1000, right: 1000, top: -1000, bottom: 1000 }}
          initial={{ scale: 1 }}
          animate={controls}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="grid grid-cols-7 gap-1 p-1"
        >
          {days.map(day => (
            <div key={day.toString()} className={`border p-2 min-h-[300px] ${!workingWindows[format(day, 'yyyy-MM-dd')] ? 'bg-gray-100' : 'bg-white'}`}>
              <div className="font-semibold">{format(day, 'EEE dd', { locale: uk })}</div>
              {appointments
                .filter(app => format(new Date(app.requested_time), 'yyyy-MM-dd') === format(day, 'yyyy-MM-dd'))
                .sort((a, b) => new Date(a.requested_time).getTime() - new Date(b.requested_time).getTime())
                .map(app => (
                  <div key={app.id} onClick={() => setSelectedAppointment(app)} className={`p-1 mb-1 text-xs rounded cursor-pointer ${getStatusColor(app.status)} ${app.telegram_id === 0 ? 'border-2 border-dashed border-gray-400' : ''}`}>
                    <span className="font-bold [text-shadow:_0_0_2px_white]" title={app.telegram_id === 0 ? "Запис без Telegram — автоматичні нагадування пацієнту не прийдуть" : ""}>
                      {(() => {
                          const start = new Date(app.requested_time);
                          const end = new Date(start.getTime() + app.estimated_duration_minutes * 60000);
                          return `${formatInTimeZone(start, 'Europe/Kyiv', 'HH:mm', { locale: uk })} - ${formatInTimeZone(end, 'Europe/Kyiv', 'HH:mm', { locale: uk })} ${app.patient_name}`;
                      })()} {app.telegram_id === 0 ? '⚠️' : ''}
                    </span>
                  </div>
                ))}
            </div>
          ))}
        </motion.div>
      </div>
      {showNewAppointmentModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4">
          <form onSubmit={handleCreateAppointment} className="bg-white p-4 rounded w-full max-w-md">
            <h2 className="text-lg font-bold mb-4">Новий запис</h2>
            {error && <p className="text-red-500 mb-2">{error}</p>}
            {isChecking && <p className="text-blue-500 mb-2">Перевірка доступності...</p>}
            <input placeholder="Ім'я пацієнта" value={newAppointment.patient_name} onChange={e => setNewAppointment({...newAppointment, patient_name: e.target.value})} className="w-full p-2 mb-2 border rounded" required />
            <select value={newAppointment.service_category} onChange={e => setNewAppointment({...newAppointment, service_category: e.target.value})} className="w-full p-2 mb-2 border rounded" required>
                <option value="">Оберіть послугу</option>
                {services.map(s => <option key={s.category} value={s.category}>{s.category}</option>)}
            </select>
            <input type="datetime-local" value={newAppointment.requested_time} onChange={e => setNewAppointment({...newAppointment, requested_time: e.target.value})} className="w-full p-2 mb-2 border rounded" required />
            <textarea placeholder="Примітки" value={newAppointment.notes} onChange={e => setNewAppointment({...newAppointment, notes: e.target.value})} className="w-full p-2 mb-2 border rounded" />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowNewAppointmentModal(false)} className="p-2 bg-gray-200 rounded">Скасувати</button>
              <button type="submit" className="p-2 bg-blue-600 text-white rounded">Зберегти</button>
            </div>
          </form>
        </div>
      )}
      {selectedAppointment && (
        <AppointmentModal 
          appointment={selectedAppointment} 
          onClose={() => setSelectedAppointment(null)} 
          onUpdate={fetchAppointments} 
        />
      )}
    </div>
  );
}

