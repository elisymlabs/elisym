import { CopyButton } from './CopyButton';
import { Icon } from './Icon';

interface Props {
  command: string;
}

/** A shell command to copy: it wraps rather than cut off on a narrow screen. */
export function CommandLine({ command }: Props) {
  return (
    <div className="rounded-10 border-line bg-surface-2 flex items-center gap-8 border py-6 pr-6 pl-10">
      <Icon name="terminal" className="text-text-3 size-16 shrink-0" />
      <code className="text-13 min-w-0 flex-1 font-mono break-all" title={command}>
        {command}
      </code>
      <CopyButton text={command} label="Copy command" />
    </div>
  );
}
