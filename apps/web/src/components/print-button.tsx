"use client";

export function PrintButton({ label = "Print / Save as PDF" }: { label?: string }) {
  return (
    <button type="button" className="btn btn-dark print:hidden" onClick={() => window.print()}>
      {label}
    </button>
  );
}
