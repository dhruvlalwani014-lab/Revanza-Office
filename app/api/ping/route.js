export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Imports nothing whatsoever, so it answers even when everything else is
 * broken. It also reports the build it belongs to: if this version does not
 * match the one shown in the console, the deployment is a mixture of files
 * from different releases and needs replacing wholesale.
 */
export async function GET() {
  return new Response(
    JSON.stringify(
      {
        ok: true,
        pong: true,
        version: '1.11.0',
        theOnlyApiRoute: '/api/docket',
        node: process.version,
        region: process.env.VERCEL_REGION || null,
        environment: process.env.VERCEL_ENV || 'unknown',
        commit: process.env.VERCEL_GIT_COMMIT_SHA ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) : null,
        time: new Date().toISOString()
      },
      null,
      2
    ),
    { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }
  );
}
