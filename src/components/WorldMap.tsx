import React, { useMemo, useState } from 'react';

const REMOTE_WORLD_MAP =
  'https://upload.wikimedia.org/wikipedia/commons/8/80/World_map_-_low_resolution.svg';

interface WorldMapProps {
  className?: string;
  src?: string;
  variant?: 'dots' | 'silhouette';
  fade?: boolean;
}

export const WorldMap: React.FC<WorldMapProps> = ({
  className = '',
  src = REMOTE_WORLD_MAP,
  variant = 'silhouette',
  fade = true,
}) => {
  const [failed, setFailed] = useState(false);

  if (!failed) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden="true"
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className={`select-none ${className}`}
        style={{ filter: 'grayscale(1)' }}
      />
    );
  }

  return <FallbackMap className={className} variant={variant} fade={fade} />;
};

const LAND_MASK = [
  '                                                                                ',
  '                       ##           #     ##  ##                                ',
  '            ###     ########       ##  ########### ##                          ',
  '         ##############       #################################                ',
  '       ##################   ###################################                ',
  '      ####################  ####################################               ',
  '       #####################  ##################################               ',
  '         ##################  ####################################              ',
  '           ##############   #####################################              ',
  '            ############    ##################################                 ',
  '             ##########    ###############################  ###                ',
  '              ########    ##########  ##################                       ',
  '                #####    #########       #############                         ',
  '                  ###  ##########         #############                        ',
  '                    # #########            ##########                          ',
  '                  ############              ##########                         ',
  '                  ###########                #########                         ',
  '                  ###########                 #######                          ',
  '                  ##########                   ######         #######          ',
  '                   #########                    ###          #########         ',
  '                   ########                     ##          ##########         ',
  '                    ######                                  #########          ',
  '                     #####                                    ####             ',
  '                      ###                                      ##              ',
  '                       #                                                       ',
  '                                                                                ',
  '                                                                                ',
  '       ##############################################################          ',
  '      ################################################################         ',
  '       ##############################################################          ',
  '         ##########################################################            ',
  '             ##################################################                ',
  '                                                                                ',
  '                                                                                ',
];

const COLS = 80;
const ROWS = LAND_MASK.length;
const CELL = 12;

interface Cell {
  x: number;
  y: number;
}

const computeCells = (): Cell[] => {
  const cells: Cell[] = [];
  for (let r = 0; r < ROWS; r++) {
    const row = LAND_MASK[r];
    for (let c = 0; c < COLS; c++) {
      if (row[c] === '#') cells.push({ x: c * CELL, y: r * CELL });
    }
  }
  return cells;
};

const FallbackMap: React.FC<{
  className: string;
  variant: 'dots' | 'silhouette';
  fade: boolean;
}> = ({ className, variant, fade }) => {
  const cells = useMemo(() => computeCells(), []);
  const w = COLS * CELL;
  const h = ROWS * CELL;
  const filterId = `wmBlur-${variant}`;
  const fadeId = `wmFade-${variant}`;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid meet"
      className={className}
    >
      <defs>
        {variant === 'silhouette' && (
          <filter id={filterId} x="-5%" y="-5%" width="110%" height="110%">
            <feGaussianBlur stdDeviation="8" />
          </filter>
        )}
        {fade && (
          <radialGradient id={fadeId} cx="50%" cy="50%" r="65%">
            <stop offset="0%" stopColor="currentColor" stopOpacity="1" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.25" />
          </radialGradient>
        )}
      </defs>
      <g
        fill={fade ? `url(#${fadeId})` : 'currentColor'}
        filter={variant === 'silhouette' ? `url(#${filterId})` : undefined}
      >
        {variant === 'dots'
          ? cells.map((c, i) => (
              <circle key={i} cx={c.x + CELL / 2} cy={c.y + CELL / 2} r={1.7} />
            ))
          : cells.map((c, i) => (
              <rect
                key={i}
                x={c.x}
                y={c.y}
                width={CELL + 1}
                height={CELL + 1}
                rx={3}
              />
            ))}
      </g>
    </svg>
  );
};
