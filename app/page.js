import { redirect } from 'next/navigation';

/**
 * The console itself is a single self-contained page served from /public,
 * so it loads in one request with no hydration step. This is the front door.
 */
export default function Home() {
  redirect('/console.html');
}
