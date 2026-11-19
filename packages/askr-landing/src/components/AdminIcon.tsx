import { ADMIN_ICON_PATHS } from '../admin-view';

interface Props {
  tab: keyof typeof ADMIN_ICON_PATHS;
}

/** An admin section's icon, as the admin draws it. */
export function AdminIcon({ tab }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-16 flex-none"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ADMIN_ICON_PATHS[tab].map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}
