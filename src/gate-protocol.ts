/** Line the host writes to a held process's stdin to let pi load. */
export const GATE_RELEASE_LINE = "pi-hostkit-gate-release-v1";
/** Exit code of the gate when stdin ends or carries anything other than the release line. */
export const GATE_REFUSED_EXIT_CODE = 75;
