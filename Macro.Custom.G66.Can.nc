%
O01066 (G81 TO G66 DRILL CYCLE)
(4.4.24. MRT. REV X1) 
(G66 AVAILABLE IN NGC SW 100.23.000.1201)

M06 T1 (DRILL) 
M03 S1500 
G54 G00 G90 X1. Y-1.5 (HOLE 1 XY) 
G43 H01 Z0.1 

/ G66 P1067 Z-2.25 R0.1 F15. I0.125 J1. (MODAL MACRO CALL) 
X2. (HOLE 2) 
X3. (HOLE 3) 
G67 (MODAL MACRO OFF) 

G00 Z2. 
M30 

(G66: Modal Macro Call)
(Z = #26 = Drill Cycle Maximum Depth)
(R = #18 = Clearance Plane)
(F = #9  = Feedrate)
(I = #4  = Extrusion Wall Thickness)
(J = #5  = Extrusion Height)


O01067   (G66 SUBPROGRAM, DRILL-RAPID-DRILL )
(4.4.24. MRT. REV X1) 
(NOTE THAT A / BLOCKS LOOKAHEAD, MAKES LOCAL VARIABLES EASIER TO SEE ON MACRO PAGE)

/ G01 G91 Z - [ 0.2 + #4 ] F#9 
/ G00 G90 Z - [ #5 - #4 - 0.1 ] 
/ G01 G90 Z - [ #5 + 0.1 ] 
/ G00 G90 Z#18 

(COPY LOCAL VAR. TO GLOBAL VAR.) 
(JUST FOR TROUBLESHOOTING) 
#100= #9 (F) 
#101= #18 (R) 
#102= #26 (Z) 
#103= #4 (I) 
#104= #5 (J) 

M99 (RETURN TO MAIN PROGRAM) 

(G66: Modal Macro Call)
(Z = #26 = Drill Cycle Maximum Depth)
(R = #18 = Clearance Plane)
(F = #9  = Feedrate)
(I = #4  = Extrusion Wall Thickness)
(J = #5  = Extrusion Height)

%
