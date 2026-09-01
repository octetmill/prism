# `reload_service` applies settings via a plain `start`, not a full `stop; start`

Superseded by the homeproxy-model service rebuild; `reload_service` is now `enabled ? start : stop`, side-effect-free property preserved. See *Service start path rebuilt on homeproxy's model*.
