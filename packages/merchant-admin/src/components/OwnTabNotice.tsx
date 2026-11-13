import { AuthLayout } from './AuthLayout';
import { Icon } from './Icon';

/** Shown instead of the key field when another page framed or opened this one. */
export function OwnTabNotice() {
  return (
    <AuthLayout>
      <div className="rounded-20 border-line bg-surface w-full max-w-520 border p-24 shadow-sm sm:p-32">
        <span className="rounded-12 bg-warn-bg text-warn grid size-40 place-items-center">
          <Icon name="alert" className="size-20" />
        </span>
        <h1 className="text-24 mt-16 font-semibold tracking-tight">
          Open this page in its own tab
        </h1>
        <p className="text-15 text-text-2 mt-8 leading-relaxed">
          This page was opened by another page, or inside one. It asks for your key only in a tab of
          its own: type its address into a new tab.
        </p>
      </div>
    </AuthLayout>
  );
}
