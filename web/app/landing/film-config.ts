import 'server-only';

export type LandingFilmAssets = {
  poster: string;
  video: string;
  captions: string;
};

const filmPath = /^\/landing\/film\/(?:[\w-]+\/)*[\w-]+(?:\.[\w-]+)+$/;

function filmAsset(value: string | undefined, extension: RegExp) {
  return value && filmPath.test(value) && extension.test(value) ? value : undefined;
}

export function landingFilmAssets(): LandingFilmAssets | undefined {
  if (process.env.RAFIQ_LANDING_FILM !== 'true') return;

  const poster = filmAsset(process.env.RAFIQ_LANDING_FILM_POSTER, /\.(webp|png|jpe?g)$/i);
  const video = filmAsset(process.env.RAFIQ_LANDING_FILM_VIDEO, /\.(mp4|webm)$/i);
  const captions = filmAsset(process.env.RAFIQ_LANDING_FILM_CAPTIONS, /\.vtt$/i);
  if (poster && video && captions) return { poster, video, captions };
}
