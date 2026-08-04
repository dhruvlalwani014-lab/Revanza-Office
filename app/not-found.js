import Link from 'next/link';

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
        color: '#16213e',
        padding: 24
      }}
    >
      <div style={{ textAlign: 'center', maxWidth: 380 }}>
        <h1 style={{ fontFamily: 'Georgia, serif', fontSize: 22, marginBottom: 8 }}>
          Nothing here
        </h1>
        <p style={{ color: '#3b4763', fontSize: 15, marginBottom: 20 }}>
          That address does not match anything in the console.
        </p>
        <Link
          href="/console.html"
          style={{
            background: '#7c1f2b',
            color: '#fff',
            padding: '11px 18px',
            borderRadius: 8,
            textDecoration: 'none',
            fontWeight: 600,
            fontSize: 15
          }}
        >
          Open the console
        </Link>
      </div>
    </main>
  );
}
