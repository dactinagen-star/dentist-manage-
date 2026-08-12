/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { useEffect, useState } from 'react';
import { supabase } from './lib/supabaseClient';
import Auth from './components/Auth';
import Calendar from './components/Calendar';
import Services from './components/Services';
import { Session } from '@supabase/supabase-js';
import { LogOut } from 'lucide-react';
import { PWAUpdateBanner } from './components/PWAUpdateBanner';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<'calendar' | 'services'>('calendar');

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (!session) {
    return <Auth />;
  }

  return (
    <div className="min-h-screen bg-pattern">
      <PWAUpdateBanner />
      <nav className="nav-bg-pattern shadow-sm p-4 flex gap-4 items-center">
        <button 
          onClick={() => setView('calendar')}
          className={`font-medium p-2 rounded transition border border-blue-300 ${view === 'calendar' ? 'bg-transparent text-blue-600' : 'bg-blue-100 text-gray-600'}`}
        >
          Календар
        </button>
        <button 
          onClick={() => setView('services')}
          className={`font-medium p-2 rounded transition border border-blue-300 ${view === 'services' ? 'bg-transparent text-blue-600' : 'bg-blue-100 text-gray-600'}`}
        >
          Послуги
        </button>
        <button
          onClick={() => supabase.auth.signOut()}
          className="ml-auto p-2 text-gray-600 hover:text-red-600 transition"
          title="Вийти"
        >
          <LogOut size={20} />
        </button>
      </nav>
      {view === 'calendar' ? <Calendar /> : <Services />}
    </div>
  );
}
