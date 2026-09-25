import { memo } from "react";
import feedback from "./drawing-feedback.module.css";

/** Only changed characters move; the current amount is always fully visible. */
export const CrispNumber = memo(function CrispNumber({ value }: { value: string }) {
  return <span className={feedback.number}><span className="sr-only">{value}</span><span aria-hidden="true">{Array.from(value).map((char, index) => <span className={feedback.digit} key={`${value.length - index}:${char}`}>{char}</span>)}</span></span>;
});
