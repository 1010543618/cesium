/*global define*/
define([
        './TerrainState'
    ], function(
        TerrainState) {
   "use strict";

   var TerrainMesh = function TerrainMesh(center, vertices, indices, minHeight, maxHeight, boundingSphere2D, boundingSphere3D, occludeePointInScaledSpace) {
       this.center = center;
       this.vertices = vertices;
       this.indices = indices;
       this.minHeight = minHeight;
       this.maxHeight = maxHeight;
       this.boundingSphere3D = boundingSphere3D;
       this.boundingSphere2D = boundingSphere2D;
       this.occludeePointInScaledSpace = occludeePointInScaledSpace;
   };

   return TerrainMesh;
});
