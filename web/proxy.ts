import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import { accountEntryEnabled, signupOpen } from './app/account-entry/config';

const clerk = clerkMiddleware({ jwtKey: process.env.CLERK_JWT_KEY });

export default function proxy(request: NextRequest, event: NextFetchEvent) {
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
