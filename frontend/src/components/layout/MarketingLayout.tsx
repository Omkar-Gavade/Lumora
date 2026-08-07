import { Outlet } from 'react-router-dom';
import { Navbar } from '@/components/marketing/Navbar';
import { Footer } from '@/components/marketing/Footer';

export function MarketingLayout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <Navbar />
      {/* Target of the skip link. tabIndex -1 so focus can actually land here. */}
      <main id="main" tabIndex={-1} className="flex-1 focus-visible:outline-none">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
