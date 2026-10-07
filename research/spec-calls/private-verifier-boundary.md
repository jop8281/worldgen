# YOS-125 proposed design calls

* Keep the current world format and introduce allowlisted public/private deployment artifacts later; loading then deleting private fields is too late for process confidentiality. Reversible before runtime implementation.
* Bind run, world revision, engine/config and task authorization in a controller-owned session; send only taskId, immutable episode trace and final snapshot to the verifier. This satisfies the narrow request while preventing caller-selected verifier/world paths. Reversible before protocol implementation.
* Treat the immutable trace as ordered calls plus authorized clock advances; reset creates a new episode. Independently replay to derive the journal and compare final time as well as tables/counters, because existing call logs omit admin advances and the state hash excludes time. Reversible before protocol implementation.
* Return a scalar only on verified success; malformed or incomplete evidence is a protocol failure, never score zero. This prevents failed verification from masquerading as a valid negative grade. Reversible before protocol implementation.
* This PR implements output-level regression tests and the design-first step only. Public/private processes, OS controls, artifact separation and deployed isolation proof remain unimplemented under YOS-125/YOS-85. No security qualification follows from these tests alone.
