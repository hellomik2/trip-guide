package app.tripguide.hybrid

import com.google.firebase.ai.type.JsonSchema
import org.json.JSONArray
import org.json.JSONObject

/**
 * The web app's answer forms are plain JSON Schema objects (app/src/engine/trip/prompts.js).
 * This turns one into the SDK's JsonSchema for generationConfig.responseJsonSchema (cloud requests).
 * Covers what those forms use: object, string, boolean, integer, number, array, enum, description, required.
 */
object SchemaJson {
    fun from(s: JSONObject): JsonSchema<*> {
        val desc = text(s, "description")
        val title = text(s, "title")
        val enum = s.optJSONArray("enum")
        return when {
            enum != null -> JsonSchema.enumeration(list(enum), desc, false, title)
            else -> when (s.optString("type")) {
                "boolean" -> JsonSchema.boolean(desc, false, title)
                "integer" -> JsonSchema.integer(desc, false, title, num(s, "minimum"), num(s, "maximum"))
                "number" -> JsonSchema.double(desc, false, title, num(s, "minimum"), num(s, "maximum"))
                "array" -> {
                    @Suppress("UNCHECKED_CAST")
                    val items = from(s.optJSONObject("items") ?: JSONObject().put("type", "string")) as JsonSchema<Any>
                    JsonSchema.array(items, desc, false, title, int(s, "minItems"), int(s, "maxItems"))
                }
                "object" -> {
                    val props = s.optJSONObject("properties") ?: JSONObject()
                    val map = LinkedHashMap<String, JsonSchema<*>>()
                    for (k in props.keys()) map[k] = from(props.getJSONObject(k))
                    val required = s.optJSONArray("required")?.let { list(it) } ?: emptyList()
                    JsonSchema.obj(map, map.keys.filter { it !in required }, desc, false, title)
                }
                else -> JsonSchema.string(desc, false, null, title)
            }
        }
    }

    private fun text(o: JSONObject, k: String): String? = if (o.isNull(k)) null else o.optString(k).ifEmpty { null }
    private fun num(o: JSONObject, k: String): Double? = if (o.has(k) && !o.isNull(k)) o.optDouble(k) else null
    private fun int(o: JSONObject, k: String): Int? = if (o.has(k) && !o.isNull(k)) o.optInt(k) else null
    private fun list(a: JSONArray): List<String> = (0 until a.length()).map { a.optString(it) }
}
