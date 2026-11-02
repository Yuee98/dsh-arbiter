import { useCallback, useEffect, useRef, useState } from 'react';
import type { WebForm, WebPoint, WebTransport } from './web-types.js';
import { copy } from './web-copy.js';
import { WebRequestError } from './web-errors.js';

export function useAnnotationEditor(
  transport: WebTransport,
  changed: (point: WebPoint) => void,
) {
  const [point, setPoint] = useState<WebPoint | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const current = useRef<WebPoint | null>(null),
    dirty = useRef(false),
    generation = useRef(0),
    blocked = useRef(false);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const failed = useRef(false);
  const accept = useCallback(
    (value: WebPoint) => {
      current.current = value;
      setPoint(value);
      changed(value);
    },
    [changed],
  );
  const failure = useCallback((value: unknown) => {
    failed.current = true;
    setError(value instanceof Error ? value.message : copy.error);
    setMessage(copy.unsaved);
  }, []);
  const save = useCallback(async () => {
    const operation = queue.current.then(async () => {
      const value = current.current;
      if (value === null || !dirty.current) return;
      if (blocked.current) throw new Error(copy.unknown);
      const before = generation.current;
      setBusy(true);
      setMessage(copy.saving);
      try {
        const saved = await transport.save({
          token: value.token,
          revision: value.revision,
          form: value.form,
          sampled: value.sampled,
        });
        const latest = current.current;
        if (latest?.token === value.token) {
          dirty.current = generation.current !== before;
          accept(
            dirty.current
              ? { ...saved, form: latest.form, sampled: latest.sampled }
              : saved,
          );
        }
        failed.current = false;
        setError('');
        setMessage(dirty.current ? copy.unsaved : copy.saved);
      } catch (error) {
        failure(error);
        throw error;
      } finally {
        setBusy(false);
      }
    });
    queue.current = operation.catch(() => undefined);
    return operation;
  }, [accept, failure, transport]);
  const flush = useCallback(async () => {
    await queue.current;
    while (dirty.current) await save();
  }, [save]);
  const open = useCallback(
    async (token: string) => {
      try {
        await flush();
        setBusy(true);
        const loaded = await transport.point(token);
        dirty.current = false;
        blocked.current = loaded.publicationPending;
        accept(loaded);
        setError('');
        setMessage(
          loaded.publicationPending
            ? copy.unknown
            : loaded.status === 'confirmed'
              ? copy.confirmed
              : '',
        );
      } catch (error) {
        failure(error);
      } finally {
        setBusy(false);
      }
    },
    [accept, failure, flush, transport],
  );
  const edit = useCallback(
    (form: WebForm, sampled?: boolean) => {
      const value = current.current;
      if (value === null) return;
      generation.current += 1;
      dirty.current = true;
      failed.current = false;
      accept({ ...value, form, sampled: sampled ?? value.sampled });
      setMessage(copy.unsaved);
    },
    [accept],
  );
  const confirm = useCallback(async () => {
    try {
      if (!blocked.current) await flush();
      const value = current.current;
      if (value === null || value.preparation !== 'ready') return;
      setBusy(true);
      try {
        const saved = await transport.confirm({
          token: value.token,
          revision: value.revision,
          form: value.form,
          sampled: value.sampled,
        });
        dirty.current = false;
        blocked.current = false;
        accept(saved);
        setMessage(copy.confirmed);
        setError('');
      } catch (error) {
        blocked.current =
          error instanceof WebRequestError ? error.pending : true;
        failure(error);
      }
    } catch (error) {
      failure(error);
    } finally {
      setBusy(false);
    }
  }, [accept, failure, flush, transport]);
  const rebase = useCallback(async () => {
    const value = current.current;
    if (value === null) return;
    setBusy(true);
    try {
      const rebased = await transport.rebase(value.token, value.revision);
      accept({ ...rebased, form: value.form, sampled: value.sampled });
      blocked.current = false;
      dirty.current = true;
      setError('');
      setMessage(copy.unsaved);
    } catch (error) {
      failure(error);
    } finally {
      setBusy(false);
    }
  }, [accept, failure, transport]);
  useEffect(() => {
    if (!dirty.current || busy || blocked.current || failed.current) return;
    const timer = setTimeout(() => {
      save().catch(failure);
    }, 500);
    return () => {
      clearTimeout(timer);
    };
  }, [point, busy, failure, save]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty.current || blocked.current) event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);
  return {
    point,
    busy,
    message,
    error,
    edit,
    open,
    save,
    confirm,
    rebase,
    flush,
    failure,
    blocked: blocked.current,
  };
}
