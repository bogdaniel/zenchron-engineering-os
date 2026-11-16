package main

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"slices"
	"strings"
	"time"
)

type agentPersona struct {
	ID                   string    `json:"id"`
	Name                 string    `json:"name"`
	Role                 string    `json:"role"`
	Responsibilities     []string  `json:"responsibilities"`
	Instructions         string    `json:"instructions"`
	Behavior             string    `json:"behavior"`
	ReviewSpecialization string    `json:"review_specialization"`
	Status               string    `json:"status"`
	Version              int       `json:"version"`
	UpdatedAt            time.Time `json:"updated_at"`
	CreatedBy            string    `json:"created_by,omitempty"`
}

type agentPersonaInput struct {
	Name                 string   `json:"name"`
	Role                 string   `json:"role"`
	Responsibilities     []string `json:"responsibilities"`
	Instructions         string   `json:"instructions"`
	Behavior             string   `json:"behavior"`
	ReviewSpecialization string   `json:"review_specialization"`
	Status               string   `json:"status"`
}

func validStoredPersona(persona agentPersona) bool {
	return validPersonaFields(persona.Name, persona.Role, persona.Responsibilities, persona.Instructions,
		persona.Behavior, persona.ReviewSpecialization, persona.Status) && persona.Version > 0 && !persona.UpdatedAt.IsZero()
}

func validPersonaFields(name, role string, responsibilities []string, instructions, behavior, review, status string) bool {
	if strings.TrimSpace(name) == "" || len(name) > 100 || strings.TrimSpace(role) == "" || len(role) > 200 ||
		len(responsibilities) > 10 || len(instructions) > 20_000 || len(behavior) > 5_000 || len(review) > 2_000 ||
		status != "active" && status != "disabled" {
		return false
	}
	for _, responsibility := range responsibilities {
		if strings.TrimSpace(responsibility) == "" || len(responsibility) > 500 {
			return false
		}
	}
	return true
}

func (input agentPersonaInput) persona() (agentPersona, bool) {
	item := agentPersona{Name: strings.TrimSpace(input.Name), Role: strings.TrimSpace(input.Role),
		Responsibilities: append([]string{}, input.Responsibilities...), Instructions: strings.TrimSpace(input.Instructions),
		Behavior: strings.TrimSpace(input.Behavior), ReviewSpecialization: strings.TrimSpace(input.ReviewSpecialization),
		Status: input.Status}
	for i := range item.Responsibilities {
		item.Responsibilities[i] = strings.TrimSpace(item.Responsibilities[i])
	}
	if item.Status == "" {
		item.Status = "active"
	}
	return item, validPersonaFields(item.Name, item.Role, item.Responsibilities, item.Instructions, item.Behavior,
		item.ReviewSpecialization, item.Status)
}

func (store *agentProfileStore) listPersonas(w http.ResponseWriter, _ *http.Request) {
	store.mu.RLock()
	items := make([]agentPersona, 0, len(store.personas))
	for _, item := range store.personas {
		items = append(items, item)
	}
	store.mu.RUnlock()
	slices.SortFunc(items, func(a, b agentPersona) int { return strings.Compare(a.Name, b.Name) })
	writeJSON(w, http.StatusOK, items)
}

func (store *agentProfileStore) createPersona(w http.ResponseWriter, r *http.Request) {
	var input agentPersonaInput
	if !decodeJSONBody(w, r, &input) {
		return
	}
	persona, ok := input.persona()
	if !ok {
		http.Error(w, "invalid persona fields", http.StatusBadRequest)
		return
	}
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		http.Error(w, "could not create persona id", http.StatusInternalServerError)
		return
	}
	persona.ID, persona.Version, persona.CreatedBy, persona.UpdatedAt = hex.EncodeToString(id), 1, accessFor(r).user, time.Now().UTC()
	store.mu.Lock()
	store.personas[persona.ID] = persona
	if err := store.persistLocked(); err != nil {
		delete(store.personas, persona.ID)
		store.mu.Unlock()
		http.Error(w, "could not persist persona", http.StatusInternalServerError)
		return
	}
	store.mu.Unlock()
	writeJSON(w, http.StatusCreated, persona)
}

func (store *agentProfileStore) updatePersona(w http.ResponseWriter, r *http.Request) {
	var input agentPersonaInput
	if !decodeJSONBody(w, r, &input) {
		return
	}
	persona, ok := input.persona()
	if !ok {
		http.Error(w, "invalid persona fields", http.StatusBadRequest)
		return
	}
	id := strings.ToLower(r.PathValue("id"))
	decoded, err := hex.DecodeString(id)
	if err != nil || len(decoded) != 16 {
		http.Error(w, "persona id must be 32 hexadecimal characters", http.StatusBadRequest)
		return
	}
	store.mu.Lock()
	previous, exists := store.personas[id]
	if !exists {
		store.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if !accessFor(r).owns(previous.CreatedBy) {
		store.mu.Unlock()
		http.Error(w, "only the persona's creator or an administrator can change it", http.StatusForbidden)
		return
	}
	persona.ID, persona.CreatedBy, persona.Version, persona.UpdatedAt = id, previous.CreatedBy, previous.Version+1, time.Now().UTC()
	store.personas[id] = persona
	if err := store.persistLocked(); err != nil {
		store.personas[id] = previous
		store.mu.Unlock()
		http.Error(w, "could not persist persona", http.StatusInternalServerError)
		return
	}
	store.mu.Unlock()
	writeJSON(w, http.StatusOK, persona)
}

func personaSnapshot(profile agentProfile, personas map[string]agentPersona) *agentPersona {
	if profile.PersonaID == "" {
		return nil
	}
	persona, exists := personas[profile.PersonaID]
	if !exists {
		return nil
	}
	return &persona
}
