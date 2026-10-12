import { type NextRequest, NextResponse } from 'next/server';

// Password-protects the usage dashboard with HTTP Basic auth (any username,
// password = ADMIN_PASSWORD). The rest of the app stays open.
export function middleware(req: NextRequest) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    return new NextResponse('Admin dashboard is disabled: set ADMIN_PASSWORD.', { status: 503 });
  }

  const header = req.headers.get('authorization') ?? '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = atob(encoded);
    const supplied = decoded.slice(decoded.indexOf(':') + 1);
    if (supplied === password) {
      return NextResponse.next();
    }
  }

  return new NextResponse('Authentication required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Avatar admin", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ['/admin', '/admin/:path*'],
};
