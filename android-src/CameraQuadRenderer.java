package io.github.rachid598.glucovision;

import android.opengl.GLES11Ext;
import android.opengl.GLES20;

import com.google.ar.core.Coordinates2d;
import com.google.ar.core.Frame;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;

/**
 * Affiche le flux caméra d'ARCore dans le fond de l'écran de visée.
 *
 * ARCore ne fournit pas d'aperçu tout fait : il écrit l'image de la caméra dans
 * une texture OpenGL externe, à charge de l'application de la dessiner. C'est
 * tout ce que fait cette classe — un quad plein écran et deux shaders. Sans elle
 * on ne verrait rien, et viser une assiette à l'aveugle n'aurait pas de sens.
 */
class CameraQuadRenderer {

    private static final String VERTEX_SHADER =
        "attribute vec4 a_Position;\n" +
        "attribute vec2 a_TexCoord;\n" +
        "varying vec2 v_TexCoord;\n" +
        "void main() {\n" +
        "  gl_Position = a_Position;\n" +
        "  v_TexCoord = a_TexCoord;\n" +
        "}\n";

    private static final String FRAGMENT_SHADER =
        "#extension GL_OES_EGL_image_external : require\n" +
        "precision mediump float;\n" +
        "varying vec2 v_TexCoord;\n" +
        "uniform samplerExternalOES u_Texture;\n" +
        "void main() {\n" +
        "  gl_FragColor = texture2D(u_Texture, v_TexCoord);\n" +
        "}\n";

    /* Quad plein écran en coordonnées normalisées. Les coordonnées de texture
       sont recalculées par ARCore à chaque changement d'orientation : le capteur
       et l'écran n'ont pas le même repère. */
    private static final float[] QUAD_COORDS = {
        -1f, -1f,  +1f, -1f,  -1f, +1f,  +1f, +1f
    };

    private final FloatBuffer quadCoords;
    private final FloatBuffer texCoordsIn;
    private final FloatBuffer texCoordsOut;

    private int program;
    private int positionAttrib;
    private int texCoordAttrib;
    private int textureUniform;
    private int textureId = -1;

    CameraQuadRenderer() {
        quadCoords = floatBuffer(QUAD_COORDS);
        texCoordsIn = floatBuffer(QUAD_COORDS);
        texCoordsOut = floatBuffer(new float[8]);
    }

    private static FloatBuffer floatBuffer(float[] values) {
        FloatBuffer fb = ByteBuffer.allocateDirect(values.length * 4)
                .order(ByteOrder.nativeOrder()).asFloatBuffer();
        fb.put(values);
        fb.position(0);
        return fb;
    }

    int createTexture() {
        int[] ids = new int[1];
        GLES20.glGenTextures(1, ids, 0);
        textureId = ids[0];
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
                GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
                GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
                GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
                GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);

        program = buildProgram();
        positionAttrib = GLES20.glGetAttribLocation(program, "a_Position");
        texCoordAttrib = GLES20.glGetAttribLocation(program, "a_TexCoord");
        textureUniform = GLES20.glGetUniformLocation(program, "u_Texture");
        return textureId;
    }

    private static int buildProgram() {
        int vs = compile(GLES20.GL_VERTEX_SHADER, VERTEX_SHADER);
        int fs = compile(GLES20.GL_FRAGMENT_SHADER, FRAGMENT_SHADER);
        int p = GLES20.glCreateProgram();
        GLES20.glAttachShader(p, vs);
        GLES20.glAttachShader(p, fs);
        GLES20.glLinkProgram(p);
        GLES20.glDeleteShader(vs);
        GLES20.glDeleteShader(fs);
        return p;
    }

    private static int compile(int type, String source) {
        int shader = GLES20.glCreateShader(type);
        GLES20.glShaderSource(shader, source);
        GLES20.glCompileShader(shader);
        return shader;
    }

    void draw(Frame frame) {
        if (textureId == -1) return;

        /* Ne recalculer les coordonnées que quand ARCore le demande : la
           transformation ne change qu'à la rotation de l'écran ou au premier
           rendu. La refaire à chaque image serait du gaspillage pur. */
        if (frame.hasDisplayGeometryChanged()) {
            frame.transformCoordinates2d(
                    Coordinates2d.OPENGL_NORMALIZED_DEVICE_COORDINATES, texCoordsIn,
                    Coordinates2d.TEXTURE_NORMALIZED, texCoordsOut);
        }
        if (frame.getTimestamp() == 0) return; // aucune image encore reçue

        GLES20.glDisable(GLES20.GL_DEPTH_TEST);
        GLES20.glDepthMask(false);
        GLES20.glUseProgram(program);

        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId);
        GLES20.glUniform1i(textureUniform, 0);

        quadCoords.position(0);
        GLES20.glVertexAttribPointer(positionAttrib, 2, GLES20.GL_FLOAT, false, 0, quadCoords);
        texCoordsOut.position(0);
        GLES20.glVertexAttribPointer(texCoordAttrib, 2, GLES20.GL_FLOAT, false, 0, texCoordsOut);

        GLES20.glEnableVertexAttribArray(positionAttrib);
        GLES20.glEnableVertexAttribArray(texCoordAttrib);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        GLES20.glDisableVertexAttribArray(positionAttrib);
        GLES20.glDisableVertexAttribArray(texCoordAttrib);

        GLES20.glDepthMask(true);
        GLES20.glEnable(GLES20.GL_DEPTH_TEST);
    }
}
