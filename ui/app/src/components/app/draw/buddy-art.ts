/** Shared vector artwork: the same Skech character in the UI and media exports. */
export function buddyArtwork(color: string, cheerful = true) {
  return [
    {d:"M25 126h54c0-27-9-46-27-46S27 98 25 126", fill:"#25304a"},
    {d:"M25 91c-3-17 10-29 27-29s32 13 27 33l-4 23H29z", fill:color},
    {d:"M44 60h17v18c-7 7-12 7-17 0z", fill:"#c78d68"},
    {d:"M29 31c0-21 45-23 47 0l-3 22c-2 14-13 20-22 20-11 0-21-10-22-23z", fill:"#e2af88"},
    {d:"M27 41c-9-26 5-39 26-37 21-3 30 12 23 36l-7-15c-10 4-20 1-24-4-2 10-10 16-18 20", fill:"#283042"},
    {d:"M30 38c-9-3-9 16 2 15m40-16c9-3 10 15-1 16", fill:"#e2af88"},
    {d:"M43 43v4m18-4v4", stroke:"#283042", width:3.5},
    {d:cheerful?"M45 56q7 7 14 0":"M46 58h12", stroke:"#7a4738", width:2.5},
    {d:"M42 77l9 8 11-8M43 84v10m17-10v10", stroke:"#ffffff", width:2, opacity:.6},
    {d:"M36 102q15 9 29 0", stroke:"#263453", width:2, opacity:.35},
    {d:"M23 81c-4 4-10 15-8 20 3 8 16 10 22 7l12-10-6-9-17 8 5-10", fill:color},
    {d:"M41 89c4-6 13-8 16-4 4 5 0 9-8 13z", fill:"#e2af88"},
    {d:"M77 74l11-26 7 3-11 26z", fill:"#ffda7c"},
    {d:"M88 48l8-10-1 13z", fill:"#e8c8a2"},
    {d:"M93 42l3-4-1 6z", fill:"#283042"},
    {d:"M73 83c-5-7-5-15 0-18 5-3 10 1 10 6l-1 12z", fill:"#e2af88"},
    {d:"M72 82l11-2c4 18-8 27-17 23l-3-11z", fill:color},
    {d:"m42 103 6-6 4 3 8-9m-6 0h6v6", stroke:"#ffffff", width:2.2},
    {d:"M41 111h22", stroke:"#ffffff", width:2, opacity:.6},
  ];
}
