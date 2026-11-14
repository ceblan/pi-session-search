---
lat:
  require-code-mention: true
---
# Pruebas de SQLite

Regresiones del acceso concurrente a los índices: comprueban WAL, errores de apertura y liberación de transacciones usando únicamente bases temporales. Complementan [[lat#Consideraciones de seguridad y robustez#Concurrencia multi-proceso en las DBs SQLite]].

Ejecutar `npm test` para la suite completa o `node --test --import tsx src/__tests__/sqlite.test.ts` para estas regresiones. Las conexiones y el worker se cierran al finalizar; no se necesitan proveedores de embeddings ni credenciales.

## WAL y lectores

Una base existente migra a WAL sin perder filas y conserva un timeout de 30 segundos. Un lector mantiene su snapshot mientras otro escritor confirma cambios, visibles al terminar la lectura.

## Apertura fallida

Un archivo que no es SQLite provoca un error de apertura y el cierre de la conexión recién creada. El fallo del pragma no debe quedar oculto hasta una operación posterior.

## Migracion bloqueada

Un lector de una base en rollback impide convertirla a WAL. La apertura debe fallar y cerrar su conexión, no devolverla en modo inseguro; una nueva apertura funciona al liberar el lector.

## Commit correcto

Una transacción confirma sus escrituras y devuelve el resultado del cuerpo. Otra conexión ve los datos confirmados.

## Rollback del cuerpo

Una excepción después de escrituras parciales restaura los datos anteriores y conserva el error original. Tanto la conexión original como otra pueden escribir después, sin locks abandonados.

## Rollback del commit

Un lector bloquea el commit en modo rollback y fuerza un error con lock PENDING. El helper revierte la escritura y permite nuevos lectores y posteriores escrituras, reproduciendo el bloqueo del incidente.

## Reserva fallida

Si otro escritor agota la espera de BEGIN IMMEDIATE, el cuerpo no se ejecuta. Al liberar al escritor, la misma conexión puede reintentar y confirmar sin transacciones residuales.

## Escritores concurrentes

Un worker retiene una escritura WAL mientras una conexión nueva intenta su primer borrado e inserción FTS5. La operación espera y termina tras liberar al escritor, sin fallar en la promoción de lectura a escritura.
