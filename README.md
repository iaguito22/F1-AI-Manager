# F1 AI Manager

Veintidós pilotos con IA que aprenden a correr, y tú llevas el muro de uno de los once equipos.
Fin de semana completo: libres 1 y 2 → Q1/Q2/Q3 → carrera, con reglaje, paradas, estrategia de neumáticos,
lluvia, radio, repeticiones y realización de TV. Hecho con three.js, sin build.

![Punta Serena: el pueblo, el puerto y el circuito sobre el acantilado](docs/img/punta-serena-puerto.jpg)

## En pista

Nadie tiene los adelantamientos ni los accidentes guionizados: salen de la física y de lo que cada piloto ha aprendido.
Aprietan más de lo que da el coche, se abren, trompean y acaban en el muro; rebufo, DRS y pelea rueda con rueda en las rectas.

| | |
|---|---|
| ![Choque dentro del túnel de Punta Serena](docs/img/choque-tunel-punta-serena.webp) | ![Varios coches enganchados en una curva de Porto Cidade](docs/img/choque-porto-cidade.webp) |
| ![Se va contra el muro en la frenada de Neural Park](docs/img/choque-neural-park.webp) | ![Dos coches tocándose y trompeando en Porto Cidade](docs/img/trompo-porto-cidade.webp) |
| ![Contra la valla en Punta Serena](docs/img/choque-punta-serena.webp) | ![Por la grava y al muro en Val d'Ambre](docs/img/choque-val-dambre.webp) |
| ![Trompo y golpe contra las protecciones en Monte Alto](docs/img/choque-monte-alto.webp) | ![Se sale en la frenada y acaba en el muro en Al Noor](docs/img/choque-al-noor.webp) |

![Adelantamiento en Monte Alto, visto desde el dron](docs/img/adelantamiento-monte-alto.webp)

| | |
|---|---|
| ![Adelantamiento en Al Noor de noche](docs/img/adelantamiento-al-noor.webp) | ![Adelantamiento por dentro en Monte Alto](docs/img/adelantamiento-monte-alto-2.webp) |

| | |
|---|---|
| ![Parrilla de Monte Alto](docs/img/monte-alto-parrilla.jpg) | ![Parrilla de Al Noor desde el dron](docs/img/al-noor-parrilla.jpg) |
| ![Curva de Monte Alto con pianos](docs/img/monte-alto-curva.jpg) | ![Al Noor de noche entre palmeras](docs/img/al-noor-noche.jpg) |
| ![Monte Alto al atardecer](docs/img/monte-alto-atardecer.jpg) | ![Recta de meta de Al Noor](docs/img/al-noor-recta.jpg) |

## Modo mánager

Eliges equipo y llevas a sus dos pilotos desde el muro: cuándo salen a pista, con qué goma y qué programa
(lanzadas, tanda seguida o hasta que los llames), reglaje, plan de paradas y, en carrera, ritmo, motor,
pelea y órdenes de equipo. El equipo te avisa cuando hay que decidir algo, y cada aviso trae su respuesta.

![Muro en carrera](docs/img/manager-carrera.webp)

![Muro con avisos del equipo](docs/img/muro-carrera.jpg)

**Garaje** (botón GARAJE o tecla G):

- **Estrategia**: tandas arrastrables sobre la gráfica de desgaste previsto, sacado de las vueltas que hizo tu equipo en libres.
- **Reglaje**: alerón y suspensión, en el garaje o con la parrilla retenida antes de dar la salida.
- **Rendimiento**: cada vuelta de tus pilotos, corregida por gasolina y goma. Se compara por reglaje, goma, ritmo o motor, y se filtra por sesión y por seco o mojado.
- **Radar**: lluvia prevista para los próximos 15 minutos, agua en la trazada y goma ideal ahora.

| | |
|---|---|
| ![Plan de paradas](docs/img/garaje-estrategia.jpg) | ![Reglaje en parrilla](docs/img/garaje-reglaje.jpg) |
| ![Comparar reglajes](docs/img/rendimiento-comparar.jpg) | ![Todas las vueltas](docs/img/rendimiento-vueltas.jpg) |
| ![Tiempo frente a desgaste](docs/img/rendimiento-grafica.jpg) | ![Resultado y resumen del muro](docs/img/resultados-carrera.jpg) |

El modo espectador sigue ahí: la retransmisión se realiza sola y eliges piloto y plano cuando quieras.

![Pantalla de inicio](docs/img/portada.jpg)

**Estadísticas de la carrera** (al terminar, pestaña Estadísticas): ganador, vuelta rápida, más adelantamientos, remontada
y parada más rápida; posiciones vuelta a vuelta, la estrategia de neumáticos de cada piloto y el ritmo de los primeros.

| | |
|---|---|
| ![Posiciones vuelta a vuelta](docs/img/estadisticas-posiciones.jpg) | ![Estrategias y ritmo](docs/img/estadisticas-estrategias.jpg) |

**Panel de aprendizaje** (tecla L): quién mejora más, dominio del circuito a lo largo del fin de semana, trazada frente a la ideal,
agarre que se atreve a usar en cada curva y lo último que ha aprendido cada piloto.

![Panel de aprendizaje](docs/img/aprendizaje.jpg)

## Circuitos

Se elige en la pantalla de inicio:

- **Neural Park**: permanente, de día, 5,2 km, escapatorias de grava y hierba.
- **Porto Cidade**: urbano y rápido junto al puerto, 6,2 km, muros cerca y yates.
- **Al Noor**: desierto de noche con torres de focos, 6 km, hotel iluminado.
- **Monte Alto**: montaña al atardecer, 5,9 km con desniveles fuertes.
- **Val d'Ambre**: bosque en otoño, nublado; la lluvia llega por zonas.
- **Punta Serena**: costa a mediodía, 6,2 km sobre el acantilado; bajada al puerto, muelle entre casas de colores y túnel bajo el pueblo.

| | |
|---|---|
| ![Punta Serena desde el mar](docs/img/punta-serena-costa.jpg) | ![El puerto deportivo bajo el acantilado](docs/img/punta-serena-acantilado.jpg) |
| ![Horquilla con el pueblo detrás](docs/img/punta-serena-horquilla.jpg) | ![Dentro del túnel](docs/img/punta-serena-tunel.jpg) |
| ![Val d'Ambre: horquilla entre árboles de otoño](docs/img/val-dambre-horquilla.jpg) | ![Val d'Ambre: el valle](docs/img/val-dambre-valle.jpg) |
| ![Porto Cidade entre edificios](docs/img/porto-cidade-ciudad.jpg) | ![Curva con escapatoria de Porto Cidade](docs/img/porto-cidade-curva.jpg) |
| ![Neural Park](docs/img/neural-park.jpg) | ![Monte Alto al atardecer](docs/img/monte-alto-atardecer.jpg) |

## Jugar

    ./jugar.sh            # Linux: abre http://localhost:8765/
    jugar.bat             # Windows (o doble clic en F1-AI-Manager.exe)

Hace falta Node.js, o los ejecutables de `release/` (`node tools/build-exe.mjs <node de Linux>` los genera).

## Multijugador

Cada amigo lleva su equipo en la misma carrera. En la pantalla de inicio, **Multijugador**: uno crea la partida
(anfitrión) y los demás se unen con la dirección de su red o con el enlace de Internet que crea la sala (túnel gratuito de
Cloudflare, sin abrir puertos), abriéndolo en Chrome/Edge. Cada 5 s se compara una huella del estado; si alguien se
separara, el anfitrión le manda una copia completa (`js/snapshot.js`), que también sirve para reconectar a mitad de partida.
Todas las máquinas simulan lo mismo con la misma semilla; el anfitrión marca el paso y reparte las órdenes de cada
muro en el paso exacto en que se aplican (`js/net.js`, `server.js`). Pausar es inmediato; seguir, velocidad, saltar
sesión, pasar de sesión y volver a la sala se votan; la salida de la carrera espera a que todos los muros estén listos.
Instrucciones para jugadores: `LEEME-MULTIJUGADOR.txt`. Comprobación sin gráficos: `node tools/mpsync.mjs` y `node tools/mpsnap.mjs`.

Opciones por URL: `?q=low` (calidad baja), `?laps=10`, `?track=gp|urban|night|mount|forest|coast`, `?wx=dry|mixed|wet`, `?start=Q1`.

## Controles

| Tecla | Acción |
|---|---|
| G | garaje (modo mánager) |
| A | realización automática on/off |
| P | automática pegada al piloto elegido (solo cambia de plano) |
| 1–8 | Exterior, Cockpit, T-Cam, Morro, Trasera, Dron, Pista, Libre |
| ← → / [ ] | piloto anterior / siguiente (o clic en la torre) |
| Espacio | pausa · `+`/`−` velocidad |
| R | repetición de lo último |
| L | panel de aprendizaje · M sonido · H ocultar HUD · Esc menú |

## Física (js/sim.js)

Coche con elipse de agarre (frenar y girar a la vez se reparten el agarre), dirección que persigue un punto
de su trazada y derrape de la trasera que el piloto caza con contravolante (mejor cuanto más constante es).
Los errores no son dados al azar: salen de apretar más de lo que da el coche (compromiso aprendido,
aire sucio, gomas frías, variación de cada entrada); se abren, se salen, trompean o tocan el muro.

## Qué aprende cada piloto (js/brain.js)

- **Trazada**: nodos laterales cada 20 m; en cada curva prueba una variación y se la queda si la curva le sale más rápida sin error.
- **Límite**: % del agarre que se atreve a usar por curva; sube explorando, baja al equivocarse.
- **Degradación** por compuesto medida en tandas largas → decide la estrategia de carrera.
- **Adelantamientos**: en qué curvas le salen (se atreve más donde ha tenido éxito).

Seco y mojado se aprenden por separado. Cada fin de semana empiezan de cero.

## Estructura

`track.js` circuito · `sim.js` física, pelea en pista, boxes, sesiones · `brain.js` aprendizaje ·
`manager.js` muro y garaje · `teamsim.js` simulador del equipo · `replay.js` repeticiones ·
`carModel.js` monoplaza · `world.js` pista y boxes · `scenery.js` alrededores · `director.js` cámaras ·
`decor.js` ciudad, puerto y focos · `ui.js` HUD · `audio.js` motor · `tools/` simulación sin gráficos para calibrar
(`node tools/weekend.mjs track=urban`, `tools/levers.mjs`, `tools/overtakes.mjs`, `tools/e2e.mjs`).
