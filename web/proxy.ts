import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import { accountEntryEnabled, signupOpen } from './app/account-entry/config';
import { appleLinkCallback, appleLinkReturnPath } from './app/account-entry/apple-link-return';
import { socialCallbackPath, socialReturnPath } from './app/account-entry/social-return';

const clerk = clerkMiddleware({ jwtKey: process.env.CLERK_JWT_KEY });

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (accountEntryEnabled() && request.nextUrl.searchParams.has('__clerk_redirect_url')) {
    // Social returns use this origin and have no development satellite redirect.
    const path = request.nextUrl.pathname;
    const provider = (['google', 'apple'] as const).find((item) => path === socialCallbackPath(item));
    const fallback = provider ? socialReturnPath(provider, undefined, 'failed')
      : path === appleLinkCallback ? appleLinkReturnPath('failed') : undefined;
    if (fallback) {
      const response = NextResponse.redirect(new URL(fallback, request.url));
      response.headers.set('Cache-Control', 'no-store');
      return response;
    }
  }
  const surface = request.nextUrl.pathname.split('/')[1];
  const usesClerk = accountEntryEnabled()
    ? surface === 'account' || surface === 'sign-in' || (surface === 'sign-up' && signupOpen())
    : process.env.NEXT_PUBLIC_RAFIQ_HOSTED_VALIDATION === 'true';
  return usesClerk ? clerk(request, event) : NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
