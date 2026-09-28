import type { ReactNode } from "react";

type IconName = "copy" | "branch" | "edit" | "trash" | "archive" | "settings" | "send" | "chevron" | "plus" | "grip" | "bolt" | "pin";

const paths: Record<IconName, ReactNode> = {
  copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  branch: <><path d="M6 4v8a5 5 0 0 0 5 5h7" /><path d="m14 13 4 4-4 4" /><circle cx="6" cy="4" r="1" /></>,
  edit: <><path d="M4 19h4l11-11-4-4L4 15v4Z" /><path d="m13 6 4 4" /></>,
  trash: <><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7" /><path d="M10 10v7m4-7v7" /></>,
  archive: <><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v12h14V8m-10 5h6" /></>,
  settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="2" fill="currentColor" stroke="none" /><circle cx="15" cy="17" r="2" fill="currentColor" stroke="none" /></>,
  send: <path d="m3 20 18-8L3 4l3 7 8 1-8 1-3 7Z" />,
  chevron: <path d="m8 10 4 4 4-4" />,
  plus: <path d="M12 4v16M4 12h16" />,
  grip: <><circle cx="8" cy="5" r="1" /><circle cx="16" cy="5" r="1" /><circle cx="8" cy="12" r="1" /><circle cx="16" cy="12" r="1" /><circle cx="8" cy="19" r="1" /><circle cx="16" cy="19" r="1" /></>,
  bolt: <path d="M13 2 5 13h6l-1 9 9-12h-6l1-8Z" />,
  pin: <><path d="m16 3 5 5-4 1-4 4-1 5-2-2-4 5 1-7-2-2 5-1 4-4 2-4Z" /><path d="m9 15-5 5" /></>,
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return <svg className="ui-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
