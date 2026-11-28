'use client';

import Image from 'next/image';
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LandingFilmAssets } from './film-config';

type Failure = 'video' | 'captions' | 'timeout' | 'poster-unavailable';

type FilmState = 'poster' | 'loading' | 'ready' | Failure;

const filmStatus: Record<FilmState, string> = {
  poster: '',
  loading: 'Loading film and English captions…',
  ready: 'Film ready. English captions are available.',
  video: 'The film could not be loaded. You can try again or continue to your account.',
  captions: 'English captions could not be loaded. You can try again or continue to your account.',
  timeout: 'The film is taking too long to load. You can try again or continue to your account.',
  'poster-unavailable': 'The film is currently unavailable. You can continue to your account.',
};

function setCaptionMode(track: TextTrack, mode: TextTrackMode) {
  track.mode = mode;
}

function FilmPlayer({ assets, video, onFailure, onClose, onReady }: {
  assets: LandingFilmAssets;
  video: RefObject<HTMLVideoElement | null>;
  onFailure: (failure: Failure) => void;
  onClose: () => void;
  onReady: () => void;
}) {
  const track = useRef<HTMLTrackElement>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [captionsReady, setCaptionsReady] = useState(false);
  const [captionsShowing, setCaptionsShowing] = useState(false);
  const ready = videoReady && captionsReady;

  useEffect(() => {
    const captionTrack = track.current;
    const tracks = video.current?.textTracks;
    if (!captionTrack || !tracks) return;
    const captions = captionTrack.track;

    function captionsLoaded() {
      if (captions.cues?.length) setCaptionsReady(true);
      else onFailure('captions');
    }

    function captionsFailed() {
      onFailure('captions');
    }

    function syncCaptionToggle() {
      setCaptionsShowing(captions.mode === 'showing');
    }

    tracks.addEventListener('change', syncCaptionToggle);
    // Track load and error events do not bubble to the parent media element.
    captionTrack.addEventListener('load', captionsLoaded);
    captionTrack.addEventListener('error', captionsFailed);
    if (captionTrack.readyState === HTMLTrackElement.LOADED) captionsLoaded();
    else if (captionTrack.readyState === HTMLTrackElement.ERROR) captionsFailed();
    else if (captions.mode === 'disabled') setCaptionMode(captions, 'hidden');

    return () => {
      tracks.removeEventListener('change', syncCaptionToggle);
      captionTrack.removeEventListener('load', captionsLoaded);
      captionTrack.removeEventListener('error', captionsFailed);
    };
  }, [onFailure, video]);

  useEffect(() => {
    const player = video.current;
    const captions = track.current?.track;
    if (!player || !captions) return;

    if (!ready) {
      const timeout = window.setTimeout(() => onFailure('timeout'), 20_000);
      return () => window.clearTimeout(timeout);
    }

    setCaptionMode(captions, 'showing');
    onReady();
    let active = true;
    void player.play().catch((error: DOMException) => {
      // A browser may require another gesture on its native Play button.
      if (active && !['NotAllowedError', 'AbortError'].includes(error.name)) onFailure('video');
    });
    return () => { active = false; };
  }, [ready, video, onFailure, onReady]);

  function toggleCaptions() {
    const captions = track.current?.track;
    if (captions) setCaptionMode(captions, captions.mode === 'showing' ? 'disabled' : 'showing');
  }

  return (
    <>
      <div className="landing-film-screen">
        <video ref={video} tabIndex={0} aria-label="The RAFIQ film" controls={ready} playsInline
          poster={assets.poster} src={assets.video} preload="auto"
          onCanPlay={() => setVideoReady(true)} onError={() => onFailure('video')}>
          <track ref={track} kind="captions" srcLang="en" label="English" src={assets.captions} />
        </video>
      </div>
      <div className="landing-actions landing-film-actions">
        {ready && (
          <button type="button" className="landing-button" aria-pressed={captionsShowing}
            onClick={toggleCaptions}>
            English captions <span aria-hidden="true">{captionsShowing ? 'On' : 'Off'}</span>
          </button>
        )}
        <button type="button" className="landing-button" onClick={onClose}>Close film</button>
      </div>
    </>
  );
}

export function LandingFilm({ assets }: { assets: LandingFilmAssets }) {
  const [state, setState] = useState<FilmState>('poster');
  const playerOpen = state === 'loading' || state === 'ready';
  const region = useRef<HTMLElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const moveFocus = useRef(false);

  const fail = useCallback((failure: Failure) => {
    moveFocus.current = region.current?.contains(document.activeElement) ?? false;
    setState(failure);
  }, []);

  const ready = useCallback(() => {
    setState(current => current === 'loading' ? 'ready' : current);
  }, []);

  useLayoutEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    const target = playerOpen ? video.current : action.current ?? status.current;
    target?.focus();
  }, [playerOpen, state]);

  function show(next: 'loading' | 'poster') {
    moveFocus.current = true;
    setState(next);
  }

  const canRetry = !playerOpen && state !== 'poster' && state !== 'poster-unavailable';

  return (
    <section ref={region} className="landing-shell landing-film landing-interactive" aria-label="The RAFIQ film">
      <p ref={status} role="status" tabIndex={-1} id="landing-film-status"
        className={state === 'ready' ? 'landing-film-announcement' : 'landing-film-status'}>{filmStatus[state]}</p>
      {state === 'poster' && (
        <div className="landing-film-screen">
          <Image src={assets.poster} width={1344} height={693} alt="" unoptimized onError={() => fail('poster-unavailable')} />
          <button ref={action} type="button" className="landing-button landing-film-play"
            onClick={() => show('loading')}>Play the RAFIQ film</button>
        </div>
      )}
      {playerOpen && (
        <FilmPlayer assets={assets} video={video} onFailure={fail} onClose={() => show('poster')} onReady={ready} />
      )}
      {canRetry && (
        <button ref={action} type="button" className="landing-button" aria-describedby="landing-film-status"
          onClick={() => show('loading')}>Retry film</button>
      )}
    </section>
  );
}
