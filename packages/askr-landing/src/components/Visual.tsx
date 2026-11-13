import { MEDIA, type MediaName, mediaUrl } from '../media';

interface Props {
  name: MediaName;
  className: string;
}

/**
 * A generated photo or loop from `src/media/`, or the placeholder light while
 * the file is not there yet. A loop plays muted and is skipped for visitors
 * who ask for reduced motion: they see the still.
 */
export function Visual({ name, className }: Props) {
  const slot: { image: string; video?: string; alt: string } = MEDIA[name];
  const image = mediaUrl(slot.image);
  const video = mediaUrl(slot.video);
  if (video !== undefined) {
    return (
      <>
        <video
          className={`object-cover motion-reduce:hidden ${className}`}
          src={video}
          poster={image}
          autoPlay
          muted
          loop
          playsInline
          aria-label={slot.alt}
        />
        {image !== undefined && (
          <img
            className={`hidden object-cover motion-reduce:block ${className}`}
            src={image}
            alt={slot.alt}
            decoding="async"
          />
        )}
      </>
    );
  }
  if (image !== undefined) {
    return (
      <img
        className={`object-cover ${className}`}
        src={image}
        alt={slot.alt}
        loading="lazy"
        decoding="async"
      />
    );
  }
  return <div aria-hidden="true" className={`media-placeholder ${className}`} />;
}
