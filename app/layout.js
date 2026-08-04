export const metadata = {
  title: 'Docket Console',
  description: 'Task, case, attendance and voice-note console',
  manifest: '/manifest.webmanifest',
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: 'Docket', statusBarStyle: 'black-translucent' }
};

export const viewport = {
  themeColor: '#16213e',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#eceef3' }}>{children}</body>
    </html>
  );
}
